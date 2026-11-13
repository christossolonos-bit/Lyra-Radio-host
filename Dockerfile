# Railway builds Lyra with this Dockerfile (simpler and steadier than its Railpack builder).
FROM node:22-slim

# ffmpeg: ffprobe reads station song titles and voice-clip lengths; ffmpeg joins podcast recordings
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
CMD ["npm", "start"]
