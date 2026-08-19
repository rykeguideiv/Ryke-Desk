FROM node:22-alpine

WORKDIR /app

# Instala as dependências antes de copiar o código para aproveitar o cache
# do Docker: mudar o servidor não obriga a baixar tudo de novo.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# Os números emitidos vivem aqui — monte um volume nesta pasta, senão cada
# reinício do contêiner distribui números novos para todo mundo.
RUN mkdir -p /data && chown -R node:node /data
ENV RYKE_DATA=/data/devices.json
ENV RYKE_PORT=8787
ENV RYKE_HOST=0.0.0.0

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "src/index.js"]
