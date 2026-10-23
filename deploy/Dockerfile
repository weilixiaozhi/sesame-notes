# syntax=docker/dockerfile:1.7
# 多阶段构建：test 热重载与 prod 运行隔离，prod 保留编译结果、数据库定义、运行依赖和官方静态素材。
# 构建上下文是仓库根目录：docker build -f deploy/Dockerfile .

# ---------- 构建阶段 ----------
FROM node:24.22.1-alpine AS frontend-build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# 先复制源码再安装：install 创建的 pnpm 链接不会被后续 COPY 覆盖
COPY apps apps
COPY packages packages
# 许可文本保持仓库内的相对路径，供构建产物与运行镜像随附。
COPY LICENSE THIRD_PARTY_NOTICES.txt ./
COPY third_party third_party
# COPY 保留构建上下文的权限位：宿主机 umask 为 077 时文件进来就是 600，
# 以 node 用户运行的 api/db-init 会读不到建库脚本、迁移 SQL 与 tsc 复制的 JSON。
# 追加式授权：只补读/遍历权限，不覆盖已有的可执行位。
RUN find apps packages third_party -type d -exec chmod a+rx {} + \
  && find apps packages third_party -type f -exec chmod a+r {} + \
  && chmod a+r LICENSE THIRD_PARTY_NOTICES.txt
# --ignore-scripts：apps/api 的 postinstall（prisma generate）稍后显式执行
# 安装时为容器内的 workspace 目录创建 pnpm 依赖链接
RUN pnpm install --frozen-lockfile --ignore-scripts

# API 编译独立于前端产物准备，按端发布只进入对应的构建阶段。
FROM frontend-build AS build
# 直接以 node 调用 CLI：pnpm exec 的 bin 解析在容器内不可靠
RUN node apps/api/node_modules/prisma/build/index.js generate --schema apps/api/prisma/schema.prisma \
  && node apps/api/node_modules/typescript/bin/tsc -p apps/api/tsconfig.build.json

# ---------- test 热重载阶段（NODE_ENV 保留 Node.js 的 development 运行模式） ----------
FROM build AS test
ENV NODE_ENV=development
RUN mkdir -p /data && chown node:node /data
USER node

# ---------- 生产依赖与产物 ----------
FROM build AS production-files
# files 白名单排除源码、测试及 seed；现有 Prisma CLI 是生产建库所需运行依赖。
RUN pnpm --filter @sesame-notes/api deploy --legacy --prod --ignore-scripts /production
# 显式复制编译产物，避免部署打包规则忽略未跟踪的 dist。
COPY --from=build /app/apps/api/dist /production/dist
RUN node /production/node_modules/prisma/build/index.js generate --schema /production/prisma/schema.prisma

# ---------- 运行阶段 ----------
FROM node:24.22.1-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# named volume 首次挂载会继承镜像内目录权限，预先授权给非 root 运行用户保存头像。
RUN mkdir -p /data && chown node:node /data
# deploy 生成独立依赖树，保留既有 API 与建库命令路径。
COPY --from=production-files /production ./apps/api
# 官方内置 GIF 的来源固定为已审核的素材目录。
COPY --from=build /app/apps/web/public/fitness/videos ./apps/web/public/fitness/videos
# node 用户可读取项目及第三方许可，路径与声明中的引用保持一致。
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.txt ./
COPY --from=build /app/third_party ./third_party
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
