FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all project files (including .env if used, though it's better to set env vars in Easypanel)
COPY . .

# Expose the API port
EXPOSE 3000

# Ensure the .cache directory exists and has proper permissions
RUN mkdir -p .cache && chmod 777 .cache

# Start the application
CMD ["npm", "start"]
