# ThoughtExpense API - Quick Start Guide

Get up and running with the ThoughtExpense API in 5 minutes.

---

## 🚀 Quick Setup

### 1. Prerequisites

- **Node.js 18+** installed
- **Docker Desktop** running
- **OpenAI API key** ([Get one here](https://platform.openai.com/api-keys))
- **Pinecone account** ([Sign up here](https://www.pinecone.io))

### 2. Clone & Install

```bash
cd backend
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add:
- Your OpenAI API key
- Your Pinecone credentials

### 4. Start Services

```bash
# Start PostgreSQL & Redis
docker-compose up -d

# Setup database
npm run prisma:generate
npm run prisma:migrate

# Start server
npm run dev
```

**Server running at**: `http://localhost:3001`

---

## 📝 First API Calls

### 1. Create Account

```bash
curl -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "you@example.com",
    "password": "yourpassword",
    "name": "Your Name"
  }'
```

**Save the token** from the response!

### 2. Parse Your First Expenses

```bash
TOKEN="your_token_here"

curl -X POST http://localhost:3001/api/expenses/parse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "rawInput": "rent 1200\ncoffee 5\nuber 15\ngroceries 80"
  }'
```

### 3. View Summary

```bash
curl http://localhost:3001/api/expenses/summary \
  -H "Authorization: Bearer $TOKEN"
```

### 4. Generate Insights

```bash
curl -X POST http://localhost:3001/api/insights/generate \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🎯 Common Use Cases

### Natural Language Formats

The AI understands various formats:

```
# Simple
rent 1000
food 50
taxi 15

# Descriptive
bought coffee for $5
paid uber driver 15 dollars
netflix monthly subscription 12

# Detailed
lunch at chipotle was 12 bucks
electricity bill this month: 80
gym membership fee $50/month
```

### Get Expenses with Filters

```bash
# By category
curl "http://localhost:3001/api/expenses?category=Food" \
  -H "Authorization: Bearer $TOKEN"

# By date range
curl "http://localhost:3001/api/expenses?startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer $TOKEN"

# With pagination
curl "http://localhost:3001/api/expenses?limit=20&offset=40" \
  -H "Authorization: Bearer $TOKEN"
```

### Update an Expense

```bash
curl -X PATCH "http://localhost:3001/api/expenses/EXPENSE_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "category": "Food",
    "amount": 25.50
  }'
```

### Delete an Expense

```bash
curl -X DELETE "http://localhost:3001/api/expenses/EXPENSE_ID" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 📊 Response Format

All responses follow this structure:

### Success Response

```json
{
  "success": true,
  "message": "Optional success message",
  "data": {}
}
```

### Error Response

```json
{
  "success": false,
  "message": "Error description",
  "errors": [
    {
      "field": "fieldName",
      "message": "Validation error message"
    }
  ]
}
```

---

## 🔑 Authentication

### Get Your Token

**Option 1: Signup**
```bash
curl -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"pass123"}'
```

**Option 2: Login**
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"pass123"}'
```

### Use Your Token

Add to every request:
```bash
-H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 📚 Available Endpoints

### Authentication
- `POST /api/auth/signup` - Create account
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get profile

### Expenses
- `POST /api/expenses/parse` - Parse natural language
- `GET /api/expenses` - List expenses
- `GET /api/expenses/:id` - Get single expense
- `PATCH /api/expenses/:id` - Update expense
- `DELETE /api/expenses/:id` - Delete expense
- `GET /api/expenses/summary` - Category summary
- `GET /api/expenses/:id/similar` - Find similar (RAG)

### Insights
- `POST /api/insights/generate` - Generate insights
- `GET /api/insights` - List insights

---

## 🎨 Expense Categories

- **Food** - Groceries, restaurants
- **Transport** - Uber, taxi, gas
- **Rent** - Housing payments
- **Utilities** - Electricity, internet
- **Shopping** - Clothes, electronics
- **Entertainment** - Movies, games
- **Healthcare** - Doctor, medicine
- **Education** - Courses, books
- **Personal Care** - Salon, grooming
- **Fees** - Bank fees, charges
- **Other** - Miscellaneous

---

## ⚡ Rate Limits

- **100 requests per 15 minutes** per IP
- Check `X-RateLimit-Remaining` header
- `429` error when exceeded

---

## 🧪 Testing

### Run Test Suite

```bash
./scripts/test-api.sh
```

### Import Postman Collection

See [API_DOCUMENTATION.md](./API_DOCUMENTATION.md#postman-collection) for the full Postman collection JSON.

---

## 🔧 Troubleshooting

### Server won't start

```bash
# Check if port 3001 is available
lsof -ti:3001

# Check Docker is running
docker ps

# Restart services
docker-compose restart
npm run dev
```

### Database errors

```bash
# Reset database
npx prisma migrate reset

# Regenerate Prisma client
npm run prisma:generate
```

### Authentication errors

- Check token is included in Authorization header
- Token format: `Bearer YOUR_TOKEN` (note the space)
- Tokens expire after 7 days - login again

---

## 📖 Full Documentation

- **Comprehensive Guide**: [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
- **OpenAPI Spec**: [openapi.yaml](./openapi.yaml)
- **TypeScript Best Practices**: [TYPESCRIPT_BEST_PRACTICES.md](./TYPESCRIPT_BEST_PRACTICES.md)
- **Build Guide**: [BUILD_SUCCESS.md](./BUILD_SUCCESS.md)

---

## 💡 Pro Tips

1. **Cache Tokens**: Store JWT securely (httpOnly cookies for web)
2. **Batch Requests**: Parse multiple expenses in one call
3. **Use Filters**: Narrow down expense queries for better performance
4. **Learn from Corrections**: Update expense categories to improve AI
5. **Monitor Confidence**: Review expenses with confidence < 0.7

---

## 🆘 Need Help?

- **Documentation**: [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
- **Issues**: Open a GitHub issue
- **Email**: support@thoughtexpense.com

---

**Ready to build?** Check out the [full API documentation](./API_DOCUMENTATION.md) for detailed guides and code examples! 🚀
