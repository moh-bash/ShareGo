FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY signaling ./signaling
COPY src ./src
COPY tsconfig.json ./

ENV SIGNALING_HOST=0.0.0.0
ENV SIGNALING_PORT=8080

EXPOSE 8080

CMD ["npm", "run", "signal"]
