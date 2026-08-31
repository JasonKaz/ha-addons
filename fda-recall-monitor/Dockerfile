FROM node:20-alpine
WORKDIR /app
COPY src/fda-recalls-scraper.js src/fda-api.js src/run.js src/logger.js src/acknowledged.js src/utils.js ./
EXPOSE 8099
CMD ["node", "run.js"]
