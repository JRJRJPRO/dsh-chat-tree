/**
 * 血缘表：sessionId → parentSession。
 *
 * 单独一个文件是因为它是**跨模块共享的可变状态**：`collect` 每次列会话时刷新它，
 * `adopt` 在分支出生时补一条，`graft` 顺着它往上找锚点。藏在谁家里都会让另外两家
 * 看起来像在偷用别人的私货。
 */

/** 血缘表：sessionId → parentSession。接管要同步跑完，来不及异步读盘。 */
export const lineage = new Map()
