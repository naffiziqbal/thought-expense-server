# ThoughtExpense Setup Guide

## Prerequisites

Before you begin, ensure you have:

1. ✅ **Node.js 18+** installed
2. ✅ **Docker Desktop** installed and **running**
3. ✅ **OpenAI API key** (sign up at https://platform.openai.com)
4. ✅ **Pinecone account** (sign up at https://www.pinecone.io)

## Step-by-Step Setup

### 1. Start Docker Desktop

**Important**: Docker must be running before proceeding!

- **macOS**: Open Docker Desktop from Applications
- **Windows**: Launch Docker Desktop from Start menu
- **Linux**: Start Docker daemon: `sudo systemctl start docker`

Verify Docker is running:
```bash
docker --version
docker ps
```

### 2. Start Database Services

From the project root directory:

```bash
docker-compose up -d
```

This will start:
- PostgreSQL (port 5432)
- Redis (port 6379)

Verify services are running:
```bash
docker-compose ps
```

You should see both services with status "Up".

### 3. Configure Backend

Navigate to backend directory:
```bash
cd backend
```

The `.env` file has been created with the Pinecone key. Update these values:

```bash
# Edit backend/.env
OPENAI_API_KEY=your-openai-api-key-here
```

**Get your OpenAI API key:**
1. Go to https://platform.openai.com/api-keys
2. Create a new secret key
3. Copy and paste it in `.env`

### 4. Set up Pinecone Index

1. Log in to https://app.pinecone.io
2. Create a new index with these settings:
   - **Name**: `thoughtexpense-embeddings`
   - **Dimensions**: `1536`
   - **Metric**: `cosine`
   - **Region**: Choose your preferred region (update `PINECONE_ENVIRONMENT` in `.env`)

3. Update `.env` with your Pinecone settings:
   - `PINECONE_ENVIRONMENT` (e.g., "us-east-1")
   - `PINECONE_INDEX_NAME` (must match the index you created)

### 5. Install Dependencies

```bash
npm install
```

### 6. Initialize Database

Generate Prisma client:
```bash
npm run prisma:generate
```

Run database migrations:
```bash
npm run prisma:migrate
```

This will create all necessary tables in PostgreSQL.

### 7. Start Backend Server

```bash
npm run dev
```

You should see:
```
✅ Redis connected
✅ Pinecone initialized
🚀 Server running on port 3001
📝 Environment: development
🔗 Health check: http://localhost:3001/health
```

### 8. Test the API

Open a new terminal and test:

```bash
# Health check
curl http://localhost:3001/health
```

Should return:
```json
{"status":"ok","timestamp":"...","uptime":...}
```

### 9. Create Your First User

```bash
curl -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123",
    "name": "Test User"
  }'
```

Save the `token` from the response - you'll need it for authenticated requests.

### 10. Parse Your First Expense

```bash
curl -X POST http://localhost:3001/api/expenses/parse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{
    "rawInput": "coffee 5\nrent 1200\nuber 15\ngroceries 80"
  }'
```

The AI will parse and categorize these expenses automatically!

## Troubleshooting

### Docker Issues

**Error**: "Cannot connect to Docker daemon"
- **Solution**: Start Docker Desktop and wait for it to fully launch

**Error**: "Port already in use"
- **Solution**: Stop other services using ports 5432 or 6379, or modify ports in `docker-compose.yml`

### Database Issues

**Error**: "Prisma schema not found"
- **Solution**: Ensure you're in the `backend` directory when running Prisma commands

**Error**: "Connection timeout"
- **Solution**: Wait for Docker containers to be fully healthy (check with `docker-compose ps`)

### API Issues

**Error**: "OpenAI API key is invalid"
- **Solution**: Check your API key at https://platform.openai.com/api-keys
- **Solution**: Ensure there's no extra whitespace in `.env`

**Error**: "Pinecone index not found"
- **Solution**: Create the index in Pinecone dashboard with exact name from `.env`
- **Solution**: Verify dimensions = 1536

### Redis Issues

**Error**: "Redis connection failed"
- **Solution**: Check if Redis container is running: `docker-compose ps redis`
- **Solution**: Restart: `docker-compose restart redis`

## Development Workflow

### Start Everything
```bash
# From project root
docker-compose up -d

# From backend directory
npm run dev
```

### Stop Everything
```bash
# Stop backend: Ctrl+C in terminal

# Stop Docker services
docker-compose down
```

### View Logs
```bash
# Backend logs: visible in terminal where you ran `npm run dev`

# Docker logs
docker-compose logs postgres
docker-compose logs redis
```

### Database Management
```bash
# Open Prisma Studio (visual database browser)
npm run prisma:studio

# Create new migration after schema changes
npm run prisma:migrate

# Reset database (WARNING: deletes all data)
npx prisma migrate reset
```

## Next Steps

Once backend is running:

1. ✅ Test all API endpoints (see `backend/README.md`)
2. ✅ Build the frontend (Next.js - coming soon)
3. ✅ Deploy to production

## Quick Reference

### Important URLs

- Backend API: http://localhost:3001
- Health Check: http://localhost:3001/health
- Prisma Studio: http://localhost:5555 (when running)

### Important Commands

```bash
# Backend
npm run dev          # Start dev server
npm run start        # Start production server
npm run prisma:studio # Open database GUI

# Docker
docker-compose up -d        # Start services
docker-compose down         # Stop services
docker-compose ps           # Check status
docker-compose logs -f      # Follow logs

# Database
npm run prisma:generate     # Generate Prisma client
npm run prisma:migrate      # Run migrations
npx prisma migrate reset    # Reset database
```

## Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Backend server port | `5000` |
| `NODE_ENV` | Environment | `development` |
| `DATABASE_URL` | PostgreSQL connection | `postgresql://...` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `JWT_SECRET` | JWT signing key | Random string |
| `OPENAI_API_KEY` | OpenAI API key | `sk-...` |
| `PINECONE_API_KEY` | Pinecone API key | `pcsk_...` |
| `PINECONE_ENVIRONMENT` | Pinecone region | `us-east-1` |
| `PINECONE_INDEX_NAME` | Pinecone index | `thoughtexpense-embeddings` |

## Support

If you encounter issues:

1. Check this troubleshooting guide
2. Review logs: `docker-compose logs` and backend terminal
3. Verify all environment variables are set correctly
4. Ensure Docker is running and healthy

Happy expense tracking! 🚀
