# Mock Anthropic API server for wind-tunnel testing.
#
#   docker build -f wind-tunnel/docker/mock-llm.Dockerfile -t swt-mock-llm wind-tunnel/mock-llm/

FROM node:22-bookworm-slim

RUN npm i -g tsx

WORKDIR /app
COPY server.ts ./

ENV PORT=8900
EXPOSE 8900

HEALTHCHECK --interval=1s --timeout=2s --retries=10 \
  CMD node -e "require('http').get('http://localhost:8900/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["tsx", "server.ts"]
