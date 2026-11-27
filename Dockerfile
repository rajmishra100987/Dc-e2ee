FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Playwright browsers ka path set karein (by default image isi path par install karti hai)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HOME=/app
ENV NODE_ENV=production

WORKDIR /app

# system dependencies install karein (pkill ke liye procps zaroori hai)
RUN apt-get update && apt-get install -y procps && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

# Browser binaries ko explicitly ensure karein (agar image mein na ho)
RUN npx playwright install chromium && chmod -R 777 /ms-playwright

COPY . .

# Data directory create karein aur permissions dein
RUN mkdir -p /app/data && chmod -R 777 /app/data /app

EXPOSE 8080

CMD ["npm", "start"]
