FROM node:20-slim

WORKDIR /app

# Install build tools for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for better caching
COPY package.json ./

# Install dependencies with increased timeout
RUN npm install --prefer-offline --no-audit --no-fund

# Copy application files
COPY . .

# Create auth directory
RUN mkdir -p auth_info

EXPOSE 3000

CMD ["node", "index.js"]
