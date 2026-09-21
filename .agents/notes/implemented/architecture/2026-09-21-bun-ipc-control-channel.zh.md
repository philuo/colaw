# Agent Note: subprocess 控制通道改走 IPC，而非继承描述符

Status: implemented

[English](2026-09-21-bun-ipc-control-channel.md) | 中文

部分取代[《Subprocess control pipe》](2026-09-11-subprocess-control-pipe.zh.md)；又被[《控制通道回归继承 fd，以文件系统流消费》](2026-09-21-control-channel-fd-fs-streams.zh.md)部分取代——fd 传输随文件系统流的子进程侧回归，本笔记"描述符不可靠"的论断收窄为 Bun 上 `net.Socket({fd})` 的确定性缺陷。

部分取代[《Subprocess control pipe》](2026-09-11-subprocess-control-pipe.zh.md)：专用通道、其环境标记与子进程 API 仍然有效；继承描述符这一传输方式及其 `overlapped` 处置不再有效。IPC 通道不是那篇笔记为负载请求所拒绝的 supervisor 自有管理协议。

## 问题

本地 subprocess 提供方把可选的控制通道承载在 fd 7 的额外继承 stdio 描述符上（`stdio[7] = 'overlapped'`；子进程打开 `new Socket({ fd: 7 })`）。Node 能确定性地接通该描述符，Bun 不能：在 1.4.0 上实测，同一进程内一次接通了 fd 7、下一次就丢弃；而 fd 3 配 `'pipe'` 完全收不到字节，配 `'overlapped'` 却能收到。该故障在描述符层面是静默的，表现为控制通道在程序收敛之前就结束。

它唯一的产品消费方是 `dsh-ptc-runtime-node`，而 `ptc` agent 预设会挂载它（`mode: ptc`），因此选中该预设的 Colaw 用户会遇到坏掉的 `run_code`。此前该测试套件被排除在 Bun 运行之外而非修复，理由是 shell 从不挂载 PTC。

## 决策

控制通道现在改走 `stdio: 'ipc'` 创建的 IPC 通道，两种运行时都能确定性地投递：

- `dsh-subprocess/control` 拥有该传输。`controlDuplex(port)` 把 IPC 端口适配为协议所用的字节模式 duplex；`controlChunk(message)` 从传输可能投递的每种形态中还原一个分片（`Buffer`、类型化数组，或两种运行时都会用的 JSON 线格式 `{ type: 'Buffer', data }`）；`openInheritedControlChannel()` 消费启动标记并适配子进程自身的 `process`。
- `controlDuplex` 同时满足两条性质。Writable 的回执是**当轮交付**，而不是端口的稍后刷出：协议在 `cork` 下先写头、再写体，而 `uncork` 在有写操作在途时无法刷出，因此回执一旦被延迟到"阻塞事件循环的程序"之后，第一帧之后的每一帧都会被滞留。端口自身的回执被单独跟踪，destroy 会先等它再断开，所以"写完最后一帧随即关闭"的程序不会丢掉那一帧。打开的 IPC 通道会让其进程保持存活，因此 destroy 还必须释放该通道。
- `dsh-subprocess-local` 在 stdio 索引 3 推入 `'ipc'`，不再填充到 fd 7；`controlPipe(child)` 适配子进程句柄。
- `SUBPROCESS_CONTROL_FD` 已移除；`SUBPROCESS_CONTROL_MARKER` 命名该传输，以便日后新增传输时不破坏兼容性。
- `subprocess-local` 的 control 套件回到 Bun 运行；原先通过 `fs.writeSync(7, …)` 注入敌对流量的 PTC fixture，改为通过 `process.send` 注入——那才是该通道真正的伪造面。
- V8 老生代上限用例在 Bun 下跳过：`maxOldGenerationSizeMb` 会变成 `--max-old-space-size`，而 Bun 忽略它，因此观测到的堆上限无法反映配置值。
- `erasable.ts` 在 Bun 上恢复了程序语言契约。Node 的 `stripTypeScriptTypes` 会拒绝需要生成代码的构造，而 PTC README 与面向模型的 `run_code` 描述都承诺只接受可擦除语法；`Bun.Transpiler` 反而为它们生成代码，因此 Bun 兜底现在会在转译前自行拒绝。

## 后果

`dsh-ptc-runtime-node` 在 Bun 下从 24 个失败用例降到 0，且传输是确定性的。最后倒下的三个是同一形态：程序在发出输出后立即阻塞事件循环。帧到达了传输层却没有到达宿主，因为 Writable 的回执把关了交付，而 `uncork` 无法越过在途写操作刷出。上面那两条适配器性质就是修复，各自在 control 套件里有对应的回归用例。

控制通道现在由传输层按消息分帧、再由协议在其上按长度分帧，因此敌对程序用 `process.send` 伪造帧，而不是直接写裸描述符。

## 考虑过的替代方案

- **Unix 域套接字。** 跨运行时且确定性强，但引入了文件系统路径、清理义务，以及与继承描述符刻意规避的沙箱交互。
- **保留 fd 7 并重试。** Bun 的行为依赖进程状态，重试会把确定性协议变成依赖时序的协议。
- **继续排除该套件。** 已否决：预设使 PTC 可达，所以排除掩盖的是用户可见的故障，而不是测试层面的限制。
