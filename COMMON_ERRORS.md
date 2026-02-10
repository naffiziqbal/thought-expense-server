# Common API Errors & Solutions

Comprehensive guide to troubleshooting ThoughtExpense API errors.

---

## Table of Contents

1. [JSON Parsing Errors](#json-parsing-errors)
2. [Authentication Errors](#authentication-errors)
3. [Validation Errors](#validation-errors)
4. [Database Errors](#database-errors)
5. [Rate Limiting](#rate-limiting)
6. [AI Service Errors](#ai-service-errors)

---

## JSON Parsing Errors

### Error: "Expected double-quoted property name in JSON"

**Cause**: Invalid JSON syntax - usually trailing comma

**Example of WRONG format**:
```json
{
  "email": "user@example.com",
  "password": "password123",  ← Trailing comma here
}
```

**Correct format**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Common mistakes**:
- ✅ **No trailing commas** in JSON
- ✅ **Double quotes** only (not single quotes)
- ✅ **Proper key formatting** ("key": "value")
- ✅ **Valid escape sequences** (\n, \t, etc.)

**Solutions**:

1. **Remove trailing commas**:
   ```bash
   # Wrong
   curl -X POST http://localhost:3001/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{
       "email": "user@example.com",
       "password": "password123",
     }'
   
   # Right
   curl -X POST http://localhost:3001/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{
       "email": "user@example.com",
       "password": "password123"
     }'
   ```

2. **Use JSON validator**: https://jsonlint.com

3. **Use proper escaping in bash**:
   ```bash
   # Option 1: Single-line JSON
   -d '{"email":"user@example.com","password":"pass123"}'
   
   # Option 2: Multi-line with proper formatting
   -d '{
     "email": "user@example.com",
     "password": "password123"
   }'
   ```

---

## Authentication Errors

### Error 401: "Not authorized to access this route"

**Causes**:
1. Missing Authorization header
2. Invalid token format
3. Expired token
4. Malformed token

**Solutions**:

#### 1. Missing Authorization Header

**Wrong**:
```bash
curl http://localhost:3001/api/expenses
```

**Right**:
```bash
curl http://localhost:3001/api/expenses \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### 2. Invalid Token Format

**Wrong formats**:
```bash
# Missing "Bearer" prefix
-H "Authorization: YOUR_TOKEN"

# Wrong spacing
-H "Authorization:Bearer YOUR_TOKEN"

# Quotes around token (in bash)
-H "Authorization: Bearer \"YOUR_TOKEN\""
```

**Correct format**:
```bash
-H "Authorization: Bearer YOUR_TOKEN"
# Note: Space after "Bearer", no quotes around token
```

#### 3. Expired Token

**Solution**: Login again to get a new token
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"yourpassword"}'
```

#### 4. Malformed Token

**Check your token**:
```bash
# Should be 3 parts separated by dots
# Format: header.payload.signature
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMyIsImlhdCI6MTYxNjI0Mzc3M30.signature
```

---

### Error 401: "Invalid email or password"

**Causes**:
1. Wrong email or password
2. User doesn't exist
3. Typo in credentials

**Solutions**:

1. **Verify credentials**:
   ```bash
   # Check if user exists by trying signup
   # If email exists, you'll get "User already exists" error
   ```

2. **Reset password** (if implemented):
   ```bash
   # Contact admin or use password reset flow
   ```

3. **Create new account**:
   ```bash
   curl -X POST http://localhost:3001/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"email":"new@email.com","password":"newpass123"}'
   ```

---

## Validation Errors

### Error 422: "Validation failed"

**Response format**:
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "field": "password",
      "message": "Password must be at least 6 characters"
    }
  ]
}
```

**Common validation errors**:

#### Email Validation

**Wrong**:
```json
{"email": "invalid-email"}  // Missing @
{"email": "test@"}          // Incomplete
```

**Right**:
```json
{"email": "user@example.com"}
```

#### Password Validation

**Wrong**:
```json
{"password": "12345"}  // Too short (< 6 chars)
{"password": ""}       // Empty
```

**Right**:
```json
{"password": "secure123"}  // At least 6 characters
```

#### Currency Validation

**Wrong**:
```json
{"currency": "US"}      // Too short
{"currency": "Dollar"}  // Not ISO code
{"currency": "usd"}     // Lowercase
```

**Right**:
```json
{"currency": "USD"}  // 3-letter ISO 4217 code, uppercase
```

#### Amount Validation

**Wrong**:
```json
{"amount": -10}      // Negative
{"amount": "10"}     // String instead of number
```

**Right**:
```json
{"amount": 10.50}    // Positive number
```

---

## Database Errors

### Error 404: "Expense not found"

**Causes**:
1. Invalid expense ID
2. Expense doesn't belong to authenticated user
3. Expense was deleted

**Solutions**:

1. **Verify expense exists**:
   ```bash
   curl "http://localhost:3001/api/expenses" \
     -H "Authorization: Bearer $TOKEN"
   ```

2. **Check expense ID format**:
   ```bash
   # Must be valid UUID v4
   # Right: 550e8400-e29b-41d4-a716-446655440000
   # Wrong: 123, abc, invalid-id
   ```

3. **Ensure you own the expense**:
   - Expenses are user-scoped
   - You can only access your own expenses

---

### Error: "User already exists with this email"

**Cause**: Email is already registered

**Solutions**:

1. **Login instead of signup**:
   ```bash
   curl -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"existing@email.com","password":"yourpass"}'
   ```

2. **Use different email**:
   ```bash
   curl -X POST http://localhost:3001/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"email":"newemail@example.com","password":"pass123"}'
   ```

---

## Rate Limiting

### Error 429: "Too many requests from this IP"

**Limit**: 100 requests per 15 minutes per IP

**Response**:
```json
{
  "success": false,
  "message": "Too many requests from this IP, please try again later."
}
```

**Solutions**:

1. **Wait 15 minutes**:
   - Rate limit window resets after 15 minutes

2. **Implement caching**:
   ```javascript
   // Cache responses client-side
   const cache = new Map();
   
   async function getExpenses() {
     if (cache.has('expenses')) {
       return cache.get('expenses');
     }
     const data = await fetch('/api/expenses');
     cache.set('expenses', data);
     return data;
   }
   ```

3. **Batch requests**:
   ```bash
   # Instead of multiple single-expense parses
   # Parse multiple at once
   curl -X POST /api/expenses/parse \
     -d '{"rawInput":"expense1 10\nexpense2 20\nexpense3 30"}'
   ```

4. **Monitor rate limit headers**:
   ```javascript
   const response = await fetch('/api/expenses');
   const remaining = response.headers.get('X-RateLimit-Remaining');
   console.log(`${remaining} requests remaining`);
   ```

---

## AI Service Errors

### Error: "Could not parse any expenses from input"

**Causes**:
1. Input too vague or ambiguous
2. No recognizable expense pattern
3. Input in unsupported language

**Solutions**:

1. **Be more specific**:
   ```bash
   # Vague
   "some stuff"
   
   # Better
   "coffee 5"
   "rent payment 1200"
   ```

2. **Include amounts**:
   ```bash
   # Missing amount
   "bought groceries"
   
   # Better
   "groceries 80"
   "bought groceries for 80 dollars"
   ```

3. **Use common terms**:
   ```bash
   # Unclear
   "thing at place was money"
   
   # Clear
   "lunch at restaurant 25"
   ```

---

### Low Confidence Scores

**Issue**: Expenses parsed with confidence < 0.7

**Example response**:
```json
{
  "expenses": [...],
  "needsReview": ["uuid-1", "uuid-2"]
}
```

**What to do**:

1. **Review flagged expenses**:
   ```bash
   # Get expense details
   curl "http://localhost:3001/api/expenses/uuid-1" \
     -H "Authorization: Bearer $TOKEN"
   ```

2. **Correct category if wrong**:
   ```bash
   # Update expense
   curl -X PATCH "http://localhost:3001/api/expenses/uuid-1" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"category":"Food"}'
   ```

3. **System learns from corrections**:
   - Future similar expenses will be more accurate
   - RAG system improves over time

---

## Connection Errors

### Error: "ECONNREFUSED"

**Causes**:
1. Server not running
2. Wrong port
3. Wrong base URL

**Solutions**:

1. **Check server is running**:
   ```bash
   curl http://localhost:3001/health
   ```

2. **Verify port**:
   ```bash
   # Check .env file
   cat backend/.env | grep PORT
   
   # Default: 3001
   # If different, update your requests
   ```

3. **Check processes**:
   ```bash
   lsof -ti:3001
   ```

---

### Error: "Cannot connect to Redis"

**Solutions**:

1. **Start Redis**:
   ```bash
   docker-compose up -d redis
   ```

2. **Check Redis status**:
   ```bash
   docker-compose ps redis
   ```

3. **Test connection**:
   ```bash
   docker-compose exec redis redis-cli ping
   # Should return: PONG
   ```

---

### Error: "Prisma client not initialized"

**Solutions**:

1. **Generate Prisma client**:
   ```bash
   npm run prisma:generate
   ```

2. **Run migrations**:
   ```bash
   npm run prisma:migrate
   ```

3. **Restart server**:
   ```bash
   # Stop with Ctrl+C, then:
   npm run dev
   ```

---

## OpenAI API Errors

### Error: "Invalid API key"

**Solutions**:

1. **Check API key**:
   ```bash
   cat backend/.env | grep OPENAI_API_KEY
   ```

2. **Verify key at OpenAI**:
   - Go to https://platform.openai.com/api-keys
   - Check if key is active
   - Check if you have credits

3. **Update .env**:
   ```bash
   OPENAI_API_KEY=sk-your-actual-key-here
   ```

4. **Restart server** after .env changes

---

### Error: "Rate limit exceeded" (OpenAI)

**Cause**: Too many AI requests

**Solutions**:

1. **Check OpenAI usage**:
   - Visit https://platform.openai.com/usage

2. **Use caching**:
   - API already caches parsed results
   - Avoid re-parsing same input

3. **Upgrade OpenAI plan**:
   - Increase rate limits
   - Get higher quotas

---

## Pinecone Errors

### Error: "Pinecone index not found"

**Solutions**:

1. **Create index in Pinecone**:
   - Go to https://app.pinecone.io
   - Create index with:
     - Name: `thoughtexpense-embeddings`
     - Dimensions: `1536`
     - Metric: `cosine`

2. **Verify .env settings**:
   ```bash
   PINECONE_API_KEY=pcsk_...
   PINECONE_INDEX_NAME=thoughtexpense-embeddings
   PINECONE_ENVIRONMENT=us-east-1
   ```

3. **Match region in .env**:
   - Check your Pinecone dashboard for region
   - Update `PINECONE_ENVIRONMENT` accordingly

---

## Testing Errors

### Test script fails

**Solutions**:

1. **Ensure server is running**:
   ```bash
   curl http://localhost:3001/health
   ```

2. **Clean test data**:
   ```bash
   # Reset database
   npx prisma migrate reset
   ```

3. **Check test user doesn't exist**:
   - Script uses `test@example.com`
   - Delete user if exists, or use different email

---

## Development Errors

### TypeScript compilation errors

**Solutions**:

1. **Check syntax**:
   ```bash
   npx tsc --noEmit
   ```

2. **Install types**:
   ```bash
   npm install --save-dev @types/package-name
   ```

3. **Clear build cache**:
   ```bash
   rm -rf dist/
   npm run build
   ```

### Nodemon not restarting

**Solutions**:

1. **Check nodemon.json**:
   ```json
   {
     "watch": ["src"],
     "ext": "ts",
     "exec": "ts-node src/index.ts"
   }
   ```

2. **Restart manually**:
   - Type `rs` in nodemon terminal
   - Or Ctrl+C and `npm run dev`

---

## Production Errors

### Environment variable errors

**Checklist**:

```bash
# Required variables
✅ PORT
✅ NODE_ENV
✅ DATABASE_URL
✅ REDIS_URL
✅ JWT_SECRET
✅ OPENAI_API_KEY
✅ PINECONE_API_KEY
✅ PINECONE_INDEX_NAME
```

**Verify**:
```bash
# Check all env vars are set
node -e "console.log(process.env)" | grep -E "(PORT|DATABASE|REDIS|JWT|OPENAI|PINECONE)"
```

---

## Quick Fixes

### Fix: Invalid JSON

**Validate JSON before sending**:
```javascript
try {
  const payload = {
    email: "user@example.com",
    password: "pass123"
  };
  const jsonString = JSON.stringify(payload);
  // jsonString is guaranteed valid JSON
} catch (error) {
  console.error('Invalid JSON:', error);
}
```

### Fix: Token Issues

**Debug token**:
```javascript
// Decode JWT (without verification)
const token = "your.jwt.token";
const [header, payload, signature] = token.split('.');
const decoded = JSON.parse(atob(payload));
console.log('Token payload:', decoded);
console.log('User ID:', decoded.id);
console.log('Expires:', new Date(decoded.exp * 1000));
```

### Fix: Connection Refused

**Start all services**:
```bash
# Start Docker
docker-compose up -d

# Wait for healthy
docker-compose ps

# Start backend
cd backend && npm run dev
```

---

## Error Response Reference

### Standard Error Format

```json
{
  "success": false,
  "message": "Human-readable error message"
}
```

### Validation Error Format

```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "field": "email",
      "message": "Please provide a valid email"
    }
  ]
}
```

### HTTP Status Code Guide

| Code | Meaning | What to do |
|------|---------|------------|
| 400 | Bad Request | Check request format |
| 401 | Unauthorized | Check token |
| 403 | Forbidden | Check permissions |
| 404 | Not Found | Check resource ID |
| 422 | Validation Failed | Fix validation errors |
| 429 | Rate Limited | Wait or cache |
| 500 | Server Error | Report to admin |

---

## Debugging Tips

### Enable Verbose Logging

```bash
# Development mode
NODE_ENV=development npm run dev
```

### Check Server Logs

```bash
# Terminal where server is running shows:
- Request logs (Morgan)
- Error traces
- Database queries (Prisma)
- Redis operations
```

### Test with Postman

1. Import collection from API_DOCUMENTATION.md
2. Set environment variables
3. Enable "Console" to see full requests/responses
4. Check "Tests" tab for assertions

### Use API Testing Tools

**HTTPie** (better than cURL):
```bash
http POST localhost:3001/api/auth/signup \
  email=user@example.com \
  password=pass123 \
  name="John Doe"
```

**Insomnia**: Visual REST client, similar to Postman

---

## Still Having Issues?

### Checklist

- [ ] Docker is running
- [ ] PostgreSQL container is healthy
- [ ] Redis container is healthy
- [ ] .env file has all required variables
- [ ] npm install completed successfully
- [ ] Prisma client generated
- [ ] Database migrated
- [ ] Server started without errors
- [ ] Port 3001 is available
- [ ] Valid OpenAI API key
- [ ] Pinecone index created

### Get Help

1. **Check documentation**:
   - [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
   - [SETUP.md](./SETUP.md)
   - [API_QUICK_START.md](./API_QUICK_START.md)

2. **Run diagnostics**:
   ```bash
   # Health check
   curl http://localhost:3001/health
   
   # Docker status
   docker-compose ps
   
   # Server logs
   # Check terminal where npm run dev is running
   ```

3. **Reset everything**:
   ```bash
   # Stop all
   docker-compose down
   
   # Start fresh
   docker-compose up -d
   cd backend
   npx prisma migrate reset
   npm run dev
   ```

4. **Report bug**:
   - Open GitHub issue
   - Include error message, endpoint, and request payload

---

## Error Prevention

### Best Practices

1. ✅ **Validate JSON** before sending
2. ✅ **Store tokens securely** (not in code)
3. ✅ **Use environment variables** for config
4. ✅ **Implement retry logic** for transient errors
5. ✅ **Cache responses** to avoid rate limits
6. ✅ **Monitor error logs** in production
7. ✅ **Test with valid data** first
8. ✅ **Read error messages** carefully

---

## Quick Reference

### Valid Signup Request
```bash
curl -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"pass123"}'
```

### Valid Parse Request
```bash
curl -X POST http://localhost:3001/api/expenses/parse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"rawInput":"coffee 5\nrent 1200"}'
```

### Valid Update Request
```bash
curl -X PATCH http://localhost:3001/api/expenses/EXPENSE_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"category":"Food","amount":10.50}'
```

---

**Remember**: Most errors are due to:
1. ❌ Invalid JSON (trailing commas, single quotes)
2. ❌ Missing/wrong authentication token
3. ❌ Services not running (Docker)

**Always check these first!** 🔍

---

**Last Updated**: February 10, 2026  
**Version**: 1.0.0
