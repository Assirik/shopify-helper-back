FROM node:22-alpine

WORKDIR /app

EXPOSE 3600

CMD ["npm", "run", "live-dev"]