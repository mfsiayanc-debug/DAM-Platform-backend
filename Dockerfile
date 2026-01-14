# Multi-stage build for production
FROM node:18-alpine AS base

# Install FFmpeg for media processing
RUN apk add --no-cache ffmpeg

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Development stage
FROM base AS development
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]