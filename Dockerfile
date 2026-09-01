FROM node:20-slim

WORKDIR /app

# Install dependencies for Baileys
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p auth_info

CMD ["node", "index.js"]
