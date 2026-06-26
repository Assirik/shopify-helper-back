FROM node:22-alpine
WORKDIR /app

# 1. Copier d'abord les manifestes (cache des layers)
COPY package*.json ./

# 2. Installer toutes les deps (dev incluses pour pouvoir compiler le TS)
RUN npm ci

# 3. Copier le reste du code source
COPY . .

# 4. Compiler le TypeScript → dist/
RUN npm run build

# 5. Lancer en mode production (pas live-dev !)
EXPOSE 3600
CMD ["npm", "run", "start"]