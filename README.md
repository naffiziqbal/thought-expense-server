# ThoughtExpense

> Natural language expense tracker powered by AI

Stop thinking in categories. Just write your expenses naturally, and let AI organize them for you.

## 💡 What is ThoughtExpense?

ThoughtExpense is an expense tracker that understands human language. Instead of filling forms and selecting dropdowns, you simply type:

```
rent 1000
uber to airport 45
bought coffee 5
groceries whole foods 120
```

The AI parses, categorizes, and learns from your patterns over time.

## 🎯 Key Features

- 🧠 **Natural Language Input**: Write expenses as you think
- 🤖 **AI Classification**: Auto-categorize with confidence scores
- 📊 **Smart Insights**: Weekly spending patterns and trends
- 🔍 **RAG Learning**: Improves accuracy from your corrections
- ⚡ **Fast & Cached**: Sub-200ms responses
- 🔒 **Private & Secure**: Your data, your control

## 🏗️ Tech Stack

### Backend
- **Node.js + Express**: RESTful API (TypeScript)
- **PostgreSQL**: Primary database with Prisma ORM
- **Redis**: Caching layer
- **Google Gemini 1.5**: Expense parsing & insights
- **Pinecone**: Vector database for RAG

### Frontend (Coming Soon)
- **Next.js 14**: App Router
- **Tailwind CSS**: Styling
- **React Query**: Data fetching
- **Recharts**: Data visualization

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Google Gemini API key ([Get one](https://makersuite.google.com/app/apikey))
- Pinecone account ([Sign up](https://app.pinecone.io))

### Installation

1. **Clone repository**
```bash
cd ThoughtExpense
```

2. **Start databases**
```bash
docker-compose up -d
```

3. **Setup backend**
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your API keys
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Backend will run on `http://localhost:7100`

4. **Test it**
```bash
curl http://localhost:7100/health
```

## 📖 Documentation

- [Backend API Documentation](backend/README.md)
- Frontend Documentation (Coming Soon)

## 🧪 Example Usage

### 1. Signup
```bash
curl -X POST http://localhost:7100/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "you@example.com",
    "password": "securepass",
    "name": "Your Name"
  }'
```

### 2. Parse Expenses
```bash
curl -X POST http://localhost:7100/api/expenses/parse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "rawInput": "coffee 5\nrent 1200\nuber 15"
  }'
```

### 3. View Summary
```bash
curl -X GET http://localhost:7100/api/expenses/summary \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## 🎨 Expense Categories

- Food
- Transport
- Rent
- Utilities
- Shopping
- Entertainment
- Healthcare
- Education
- Personal Care
- Fees
- Other

## 📊 Project Structure

```
ThoughtExpense/
├── backend/                 # Express API
│   ├── src/
│   │   ├── config/         # DB, Redis, Pinecone
│   │   ├── controllers/    # Request handlers
│   │   ├── middleware/     # Auth, validation
│   │   ├── routes/         # API routes
│   │   ├── services/       # AI & RAG logic
│   │   └── index.js        # Entry point
│   ├── prisma/
│   │   └── schema.prisma   # Database schema
│   └── package.json
├── frontend/               # Next.js app (coming soon)
├── docker-compose.yml      # PostgreSQL + Redis
└── README.md
```

## 🧠 How It Works

### 1. Natural Language Parsing
- User inputs messy expense text
- OpenAI GPT extracts structure
- Regex handles amounts & currency
- Confidence scores flag uncertain entries

### 2. Smart Classification
- AI categorizes based on description
- RAG retrieves similar past expenses
- User corrections improve accuracy
- Context builds over time

### 3. Insights Generation
- Weekly/monthly analysis
- Spending patterns & trends
- Non-judgmental observations
- Cached for performance

## 🔐 Security

- JWT authentication
- Bcrypt password hashing (12 rounds)
- Rate limiting (100 req/15min)
- Helmet.js security headers
- Input validation
- Encrypted data at rest

## 🚧 Roadmap

### MVP (Current)
- [x] Backend API
- [x] Natural language parsing
- [x] AI categorization
- [x] RAG system
- [x] Basic insights
- [ ] Frontend UI
- [ ] User dashboard
- [ ] Expense table view

### Post-MVP
- [ ] Multi-currency conversion
- [ ] Mobile app
- [ ] Export to CSV
- [ ] Budget tracking
- [ ] Bank integrations
- [ ] Recurring expenses

## 🤝 Contributing

This is a portfolio project, but suggestions are welcome!

## 📝 License

MIT

## 🙏 Acknowledgments

Built following the PRD philosophy: **Build the MVP. Let users complain. Then evolve.**

---

**Note**: Add your OpenAI API key to `backend/.env` before running.
