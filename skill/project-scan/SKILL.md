---
name: project-scan
description: 快速摸清一个陌生代码项目的结构与技术栈，产出项目说明书式摘要。当用户说"这个项目是干什么的 / 介绍一下这个代码库 / 帮我熟悉下项目结构"时使用。
---

# 项目结构扫描

## 目标
在不修改任何文件的前提下，用尽量少的工具调用产出准确的项目概览。

## 执行步骤
1. `list_dir` 深度 2，摸清顶层结构（跳过 node_modules / .git 等）。
2. 用 `find_files` 找出关键清单文件：`package.json`、`pyproject.toml`、`requirements.txt`、`go.mod`、`Cargo.toml`、`pom.xml`、`Dockerfile`、`docker-compose.yml`。
3. 对找到的每个清单文件用 `read_file` 读取，提取：项目名、依赖、脚本命令（scripts / entrypoints）。
4. 识别入口：搜 `search_text` 模式 `(func main|if __name__|app\.listen|createServer|FastAPI\(|express\()`，定位主入口文件。
5. 读 README（若存在）取其自述定位，但要与代码事实交叉核对，冲突时以代码为准并指出差异。
6. 不要读取 `.env`、`agent.key`、凭据类文件；如项目有 `.env.example` 可读其键名。

## 输出格式
```
# 项目概览：<名称>

## 是什么
（2~3 句，基于代码事实判断，不要照抄 README 的宣传语）

## 技术栈
- 语言/运行时：
- 框架：
- 依赖管理：
- 构建/测试：

## 目录结构
关键目录与职责（带树状缩进，只列有意义的）

## 入口与运行方式
- 主入口文件：
- 启动命令：
- 端口/配置项来源：

## 值得注意
- 2~5 条：潜在风险、缺失项（无测试/无锁文件/版本过旧）、可改进点
```

## 注意
- 全程只读。若需要执行构建或安装依赖才能确认，先说明并征求同意。
- 结论必须能被你读到的文件内容支撑；不确定的写"未确认"，不要脑补。
