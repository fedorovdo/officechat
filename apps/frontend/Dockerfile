FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["sh", "-c", "npm install --prefer-offline --no-audit --no-fund && npm run dev"]
