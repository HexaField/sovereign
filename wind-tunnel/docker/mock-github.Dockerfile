# Mock GitHub API (GraphQL + REST) for wind-tunnel testing of the forge adapter.
#
#   docker build -f wind-tunnel/docker/mock-github.Dockerfile -t swt-mock-github wind-tunnel/mock-github/

FROM node:22-bookworm-slim

RUN npm i -g tsx

WORKDIR /app
COPY server.ts model.ts ./

ENV PORT=8910
EXPOSE 8910

HEALTHCHECK --interval=1s --timeout=2s --retries=10 \
  CMD node -e "require('http').get('http://localhost:8910/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["tsx", "server.ts"]
