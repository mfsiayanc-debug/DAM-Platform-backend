# DAM Platform Backend

Digital Asset Management Platform backend with Node.js, Express, BullMQ, MinIO, and PostgreSQL.

## Architecture

- **API Service**: Express REST API for asset management
- **Worker Service**: BullMQ workers for background processing
- **PostgreSQL**: Relational database for asset metadata
- **Redis**: Message queue and caching
- **MinIO**: S3-compatible object storage

## Features

- Multi-file upload with validation
- Background processing with BullMQ
- Thumbnail generation (Sharp)
- Video transcoding (FFmpeg)
- Metadata extraction
- Auto-tagging based on filename/MIME type
- Download tracking
- Search and filtering

## Prerequisites

- Docker & Docker Compose (for local development)
- Node.js 18+ (for local development without Docker)
- FFmpeg (for video processing)

## Quick Start (Docker)

1. **Clone and setup**
   ```bash
   cd backend
   cp .env.example .env
   ```

2. **Start all services**
   ```bash
   docker-compose up -d
   ```

3. **Check services**
   - API: http://localhost:3001/health
   - MinIO Console: http://localhost:9001 (admin/minioadmin)
   - BullMQ Dashboard: http://localhost:3002

4. **View logs**
   ```bash
   docker-compose logs -f api
   docker-compose logs -f worker
   ```

## Local Development (without Docker)

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Setup PostgreSQL**
   ```bash
   createdb dam_platform
   ```

3. **Start Redis**
   ```bash
   redis-server
   ```

4. **Start MinIO**
   ```bash
   minio server /data
   ```

5. **Run migrations**
   ```bash
   npm run migrate
   ```

6. **Start API server**
   ```bash
   npm run dev
   ```

7. **Start worker (in another terminal)**
   ```bash
   npm run worker
   ```

## API Endpoints

### Assets

- `POST /api/assets/upload` - Upload multiple files
- `GET /api/assets` - Get all assets (with filters)
- `GET /api/assets/:id` - Get asset by ID
- `GET /api/assets/:id/download` - Download asset
- `DELETE /api/assets/:id` - Delete asset
- `PATCH /api/assets/:id/tags` - Update asset tags

### Stats

- `GET /api/stats` - Get dashboard statistics

### Query Parameters

**GET /api/assets**
- `type`: Filter by type (image, video, document, all)
- `search`: Search by name or tags
- `sortBy`: Sort field (uploaded_at, name, downloads)
- `order`: Sort order (ASC, DESC)
- `limit`: Results per page (default: 50)
- `offset`: Pagination offset (default: 0)

## Environment Variables

See `.env.example` for all configuration options.

Key variables:
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_HOST`: Redis host
- `MINIO_ENDPOINT`: MinIO endpoint
- `WORKER_CONCURRENCY`: Number of concurrent jobs

## Docker Deployment

### Development

```bash
docker-compose up -d
```

### Production (Docker Swarm)

1. **Initialize Swarm**
   ```bash
   docker swarm init
   ```

2. **Build and push images**
   ```bash
   docker build -t your-registry/dam-api:latest -f Dockerfile .
   docker build -t your-registry/dam-worker:latest -f Dockerfile.worker .
   docker push your-registry/dam-api:latest
   docker push your-registry/dam-worker:latest
   ```

3. **Deploy stack**
   ```bash
   docker stack deploy -c docker-compose.swarm.yml dam
   ```

4. **Scale workers**
   ```bash
   docker service scale dam_worker=5
   ```

5. **Monitor services**
   ```bash
   docker service ls
   docker service logs dam_worker
   ```

## Worker Processing

The worker handles:

1. **Image Processing**
   - Generate thumbnails (400px width)
   - Extract metadata (dimensions, format)
   - Upload to MinIO

2. **Video Processing**
   - Extract video thumbnail
   - Get metadata (duration, resolution, codec)
   - Optional: Transcode to multiple resolutions

3. **Document Processing**
   - Extract basic metadata
   - Future: PDF page count, text extraction

## Scaling

### Scale API horizontally

```bash
docker service scale dam_api=4
```

### Scale workers based on queue size

```bash
# Monitor queue
docker exec dam-redis redis-cli LLEN bull:asset-processing:wait

# Scale up
docker service scale dam_worker=10

# Scale down
docker service scale dam_worker=2
```

### Auto-scaling (Kubernetes)

For production auto-scaling, deploy to Kubernetes with HPA:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: dam-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: dam-worker
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: External
    external:
      metric:
        name: bullmq_queue_waiting
      target:
        type: AverageValue
        averageValue: "10"
```

## Monitoring

### BullMQ Dashboard

Access at http://localhost:3002 to monitor:
- Active jobs
- Completed jobs
- Failed jobs
- Job details and logs

### Health Checks

```bash
curl http://localhost:3001/health
```

### Logs

```bash
# API logs
docker-compose logs -f api

# Worker logs
docker-compose logs -f worker

# All logs
docker-compose logs -f
```

## Security Considerations

1. **Change default credentials** in production
2. **Use environment variables** for secrets
3. **Enable HTTPS** with reverse proxy (nginx/traefik)
4. **Implement authentication** (JWT/OAuth)
5. **Add rate limiting** (already included)
6. **Validate file types** strictly
7. **Scan uploads** for malware
8. **Use signed URLs** for private assets

## Performance Tips

1. **Increase worker concurrency** based on CPU cores
2. **Use Redis cluster** for high availability
3. **Enable MinIO distributed mode** for scaling
4. **Add CDN** for asset delivery
5. **Implement caching** for frequently accessed assets
6. **Database indexing** on search fields
7. **Connection pooling** for database

## Troubleshooting

### Worker not processing jobs

```bash
# Check Redis connection
docker exec dam-redis redis-cli ping

# Check queue
docker exec dam-redis redis-cli LLEN bull:asset-processing:wait

# Restart worker
docker-compose restart worker
```

### Out of memory

Increase worker memory limits in docker-compose.yml:

```yaml
deploy:
  resources:
    limits:
      memory: 2G
```

### Video processing fails

Ensure FFmpeg is installed:

```bash
docker exec dam-worker ffmpeg -version
```

## License

MIT
