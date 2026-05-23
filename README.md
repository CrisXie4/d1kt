# d1kt-node-harness

一个本地 Node.js 测试小工具，用浏览器面板触发 d1kt.cn 词汇 study-words 抓取，并自动按真实节奏跑完三种 test（中译英 / 听音译英 / 选择题），把 test-record 提交回去。

> 仅供个人学习自动化使用，请遵守目标站点的服务条款。

## 功能

- 浏览器表单录入账号 / 密码，后端代为登录拿到 JWT 和用户 ID
- 后端串起 study-words → 三个独立的 test-attempt / test-record 流程
- 每道题的提交时间随机化，更贴近真人作答节奏
- `answerProof` 按 d1kt 当前前端公式生成：`md5("d1ktsalt" + ":" + attemptId + ":" + questionToken + ":" + submittedAt + ":" + userAnswer + ":" + "d1ktsalt")`
- 任务在后端异步执行，前端轮询展示进度、日志和单词列表

## 运行

需要 Node.js 18 及以上。

```bash
npm start
```

默认监听 `http://127.0.0.1:3000`，可用 `PORT` 环境变量改端口：

```bash
PORT=4000 npm start
```

打开浏览器访问首页填表 → 「开始测试」。

## 表单字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| Base URL | `https://d1kt.cn` | 目标站点根地址 |
| study-words 路径 | `/api/api/vocabulary/study-words/` | 拉取单词的接口前缀，会拼上用户 ID |
| test-attempt 路径 | `/api/api/vocabulary/test-attempt` | 创建一次测试的接口 |
| 提交结果路径 | `/api/api/vocabulary/test-record` | 提交答题结果的接口 |
| 账号 | — | d1kt 登录账号 |
| 密码 | — | d1kt 登录密码 |
| 单词数量 | `100` | 1–500 |
| 超时 (ms) | `15000` | 单个请求超时时间 |

> 后端会向 `/api/api/auth/login` 发送 `{ username, password }`，从响应里取出 `token` 当 JWT、`user._id` 当用户 ID；之后所有 d1kt 请求都通过 `Authorization: Bearer`、`Cookie: token=...` 以及 JSON body 的 `jwt` 字段一起发送。

## 项目结构

```
server.js                      入口，启动 HTTP 服务
src/
  server.js                    路由 / 静态资源 / 请求参数校验
  services/
    d1ktClient.js              对 d1kt 接口的封装
    jobStore.js                内存里的任务状态机
    runVocabularyJob.js        抓单词 + 跑三种测试 + 计算 answerProof
  utils/
    extractWords.js            从 study-words 响应里整理出单词
public/
  index.html / app.js / style.css   浏览器面板
```

任务数据只保存在进程内存里，重启后会丢失。

## 凭据失效

服务端拿到的 JWT 默认 1 天有效期，过期后所有接口会 401。当前实现是「每次创建任务都重新登录拿一次新 token」，所以只要账号密码没变就不用管。
