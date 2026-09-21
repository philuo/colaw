# Agent Note: 控制通道回归继承 fd，以文件系统流消费

Status: implemented

[English](2026-09-21-control-channel-fd-fs-streams.md) | 中文

部分取代[《subprocess 控制通道改走 IPC，而非继承描述符》](2026-09-21-bun-ipc-control-channel.zh.md)：IPC 传输退役，fd 7 传输回归；那篇笔记中留存的是子进程侧的约束结论，而非传输选择本身。

## 问题

IPC 传输的代价不止字节：`Buffer` 帧会序列化成 JSON 线格式（Bun 1.4.2 实测 2.0 倍膨胀、端到端约 28 MB/s，而原始描述符字节是 memcpy 量级），且 `process.send` 要穿过协议并不需要的逐消息机制。当初放弃 fd 7 依赖两个论断——Bun 接通额外描述符是非确定性的，且没有绕过方式。在 Bun 1.4.2（macOS arm64）上的重新测量推翻了第一条，并把第二条收窄：

- 父进程（Bun）写 `child.stdio[7]`、子进程读：20/20 帧全部到达，`'overlapped'` 与 `'pipe'` 皆然。
- Bun 子进程 + `net.Socket({fd})`（旧的子进程侧）：0/20——这是 Bun 对继承描述符上 `Socket` 的确定性缺陷，不是描述符不可靠。
- Bun 子进程 + `fs.createReadStream('', {fd})`：10/10 到达；裸 `readSync` 相同。
- 子进程（Bun 与 Node）`writeSync(fd, …)` → 父进程 `stdio[7]` `data`：两种运行时都到达。
- Bun 父进程 → Node 子进程 + `Socket({fd})`：6/6——Node 子进程从来没问题。

## 决策

fd 7 回归为传输。父进程端点就是 IPC 往返之前的 `child.stdio[7]`；子进程端点是新的——`openInheritedControlChannel()` 构建一个字节双工：读取方向从 `fs.createReadStream('', {fd, autoClose: false})` 推进，写入方向经 `writeSync` 同步进入内核。同步写是承重墙：异步流会把程序在阻塞事件循环前刚写出的帧滞留在自己的缓冲里（运行时必须观察到紧邻非让步循环之前的 console 输出），而写满的描述符会阻塞写入者——这正是协议帧上限所假设的有界背压。标记值回归 `pipe`；`SUBPROCESS_CONTROL_FD` 再次导出。

IPC 时代的约束仍然成立：control 套件留在 Bun 运行里；V8 老生代上限用例在 Bun 上依旧跳过（`--max-old-space-size` 在 Bun 上无效）；敌对流量 fixture 依旧通过裸描述符注入。IPC 笔记记录的那条生命周期差异是真实的，现已钉在属于它的位置：Bun 会在子进程 EOF 时拆掉处于暂停状态的父端点，因此"暂停端点不被清空"的契约在 Node 上成立、在 Bun 上退化为"处置会把端点落地为关闭"。

## 后果

通道重新变为字节透明——完整描述符吞吐、无逐帧序列化、实测的 IPC 成本消失。子进程在所有运行时上运行同一实现。失败模式与旧的完全一致且不再增加：对端死亡经写入路径以 EPIPE 呈现；被暂停的父端点未清空的帧在子进程退出时丢失——与 IPC 往返之前一样。协议层（`JsonChannel`）、帧上限与所有消费者一行未动。

## 备选方案

- **保留 IPC 传输并记录吞吐边界。** 基于实测被否：2 倍膨胀与 ~28 MB/s 的上限，换不来任何超过"两个运行时都能确定性地投递、只要子进程正确消费"的描述符的价值。
- **IPC 上改用 `serialization: 'advanced'`。** 结构化克隆会按字节携带 Buffer，但这把协议钉死在一个 Bun 支持度需要逐版本复验的序列化模式上，而这个通道从不需要 IPC 语义。

## 测试

`packages/subprocess/subprocess/tests/control.spec.ts` 通过随包 helper 拉起真实子进程：256 KiB 二进制回显、二十次顺序 spawn、以及标记契约。`packages/subprocess/subprocess-local/tests/control.spec.ts` 钉住托管处置语义；`packages/ptc-runtime/ptc-runtime-node` 套件钉住引导握手、经裸描述符写入的敌对流量拒绝，以及运行时说明文案。
