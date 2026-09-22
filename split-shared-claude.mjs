/**
 * 一次性修复：把被多个 DSH 会话共用的 Claude 会话拆开 —— 给每条抄一份只属于它的记录文件
 * （见 src/host/split.js 顶部，含第一版为什么错了）。
 *
 * 跑法（dsh **必须停着**）：
 *   node split-shared-claude.mjs            # 只看，不写
 *   node split-shared-claude.mjs --apply    # 真写
 *   DSH_HOME=E:/Programs/deepseek-harness/home node split-shared-claude.mjs --apply
 *
 * 为什么必须停着：会话在跑时 dsh-claude 每 150ms 原子覆盖一次旁车，这边哪怕只是读，
 * 开着的句柄也会让它 rename EPERM、整轮判失败（src/host/rewind.js 开头）。
 * 所以有 dsh 进程在就直接拒绝 —— 连"只看"都不做。
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { dshHome } from './src/host/paths.js'
import { applySplit, diskIo, planSplit, readSidecarDir } from './src/host/split.js'

/** 有没有 dsh 在跑。认 `bin.js web|desktop|headless` 和它的 subprocess runner。 */
function dshRunning() {
	if (process.platform !== 'win32') {
		try {
			return execFileSync('pgrep', ['-f', 'dsh/lib/bin.js|dsh-subprocess-local'], { encoding: 'utf8' }).trim().length > 0
		} catch {
			return false
		}
	}
	try {
		const out = execFileSync('powershell', [
			'-NoProfile', '-Command',
			"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine",
		], { encoding: 'utf8' })
		return /dsh[\\/]lib[\\/]bin\.js|dsh-subprocess-local/.test(out)
	} catch {
		return true // 查不到就当在跑：赌错了只是要你手动确认，赌反了会打死一轮对话
	}
}

const apply = process.argv.includes('--apply')
if (dshRunning()) {
	console.error('拒绝：检测到 dsh 还在跑。先完全退出 dsh（含所有 Claude 子进程）再来。')
	process.exit(2)
}

const dir = join(dshHome(), 'plugins', 'dsh-claude', 'sessions')
const io = diskIo()
const entries = readSidecarDir(dir)
const plan = planSplit(entries, io.transcriptOf)
console.log(`旁车目录：${dir}`)
console.log(`读到 ${entries.length} 份；被多个会话共用的 Claude 会话 ${plan.groups.length} 个`)
for (const group of plan.groups) {
	console.log(`
  ${group.claudeSessionId}  ← ${group.sessions.length} 条 DSH 会话`)
	for (const step of plan.fork.filter((item) => item.claudeSessionId === group.claudeSessionId)) {
		console.log(`     fork ${step.sessionId}  ← 第 ${step.turn} 轮 ${step.anchor.slice(0, 8)}…  → 新会话 ${step.newId.slice(0, 8)}…`)
	}
	for (const item of plan.stuck.filter((it) => it.claudeSessionId === group.claudeSessionId)) {
		console.log(`     ⚠ 卡住 ${item.sessionId}（${item.why}）—— 没法 fork；它下次仍会从共享文件的当前链续`)
	}
}
console.log(`
待 fork ${plan.fork.length} 条，卡住 ${plan.stuck.length} 条`)
if (!apply) {
	console.log('（只看不写。确认无误后加 --apply）')
	process.exit(0)
}
const result = applySplit(entries, plan, io)
console.log(`已 fork ${result.written.length} 条${result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 条：${JSON.stringify(result.skipped)}` : ''}`)
console.log('完成。老的共享记录文件留着当档案，谁也不再往里写。现在可以启动 dsh。')
