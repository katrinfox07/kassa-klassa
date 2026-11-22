FROM node:22-alpine
RUN apk add --no-cache poppler-utils imagemagick tesseract-ocr tesseract-ocr-data-rus tesseract-ocr-data-eng
WORKDIR /app
COPY package.json server.js toc-ekl5g.txt ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
