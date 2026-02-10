# Pinecone Index Update Guide

**Critical**: Required for Gemini embeddings to work

---

## 🚨 Why Update?

After migrating from OpenAI to Gemini, the embedding dimensions changed:

- **OpenAI** `text-embedding-3-small`: **1536 dimensions**
- **Gemini** `text-embedding-004`: **768 dimensions**

Your Pinecone index must match the embedding dimensions exactly, or upserts will fail.

---

## 🎯 Quick Update Steps

### Option 1: Pinecone Dashboard (Recommended)

1. **Go to Pinecone Console**
   ```
   https://app.pinecone.io
   ```

2. **Delete Old Index**
   - Find index: `thoughtexpense-embeddings`
   - Click **Delete**
   - Confirm deletion

3. **Create New Index**
   - Click **Create Index**
   - **Name**: `thoughtexpense-embeddings`
   - **Dimensions**: `768` ⚠️ (IMPORTANT)
   - **Metric**: `cosine`
   - **Pod Type**: `p1.x1` (or your preference)
   - **Region**: Match your `PINECONE_ENVIRONMENT` (e.g., `us-east-1`)
   - Click **Create Index**

4. **Wait for Index to be Ready**
   - Status should show "Ready" (takes ~1 minute)

5. **Done!** ✅
   - Your backend will now work with Gemini embeddings

---

### Option 2: Use Different Index Name

If you want to keep the old index for reference:

1. **Create New Index in Dashboard**
   - **Name**: `thoughtexpense-embeddings-gemini`
   - **Dimensions**: `768`
   - **Metric**: `cosine`
   - Click **Create Index**

2. **Update `.env` File**
   ```bash
   # Change this line:
   PINECONE_INDEX_NAME=thoughtexpense-embeddings-gemini
   ```

3. **Restart Server**
   ```bash
   npm run dev
   ```

---

### Option 3: Pinecone CLI (Advanced)

If you have Pinecone CLI installed:

```bash
# Install CLI if needed
pip install pinecone-client

# Set API key
export PINECONE_API_KEY="your-api-key"

# Delete old index
pinecone delete-index thoughtexpense-embeddings

# Create new index with 768 dimensions
pinecone create-index thoughtexpense-embeddings \
  --dimension 768 \
  --metric cosine \
  --pod-type p1.x1 \
  --environment us-east-1
```

---

## ⚠️ Important Notes

### Data Loss Warning

**Deleting the index will remove all stored embeddings!**

- All vector data will be lost
- Expense records in PostgreSQL are safe
- You can regenerate embeddings by re-parsing expenses

### What Gets Lost?

- ❌ Expense embeddings (vectors in Pinecone)
- ❌ Similar expense queries will be empty initially
- ✅ Expense data (safe in PostgreSQL)
- ✅ User data (safe in PostgreSQL)
- ✅ All other data (safe)

### Regenerating Embeddings

After creating the new index, embeddings will be automatically regenerated when:
- You parse new expenses
- The RAG system processes expenses

Old expenses won't have embeddings until re-parsed or manually regenerated.

---

## 🧪 Verify Index Configuration

After creating the new index, verify the settings:

### In Pinecone Dashboard

1. Go to your index
2. Check **Configuration** tab:
   - ✅ Dimensions: `768`
   - ✅ Metric: `cosine`
   - ✅ Status: `Ready`

### Using Code

Add this test script to verify:

```typescript
// Test embedding dimensions
import { generateEmbedding } from './src/services/gemini.service';

async function testEmbedding() {
  const text = "test expense";
  const embedding = await generateEmbedding(text);
  console.log(`Embedding dimensions: ${embedding.length}`);
  console.log(embedding.length === 768 ? '✅ Correct!' : '❌ Wrong dimensions!');
}

testEmbedding();
```

Expected output:
```
Embedding dimensions: 768
✅ Correct!
```

---

## 🐛 Troubleshooting

### Error: "Dimension mismatch"

**Symptom**:
```
Error: Dimension mismatch: expected 1536, got 768
```

**Solution**: You haven't updated the Pinecone index yet. Follow Option 1 above.

---

### Error: "Index not found"

**Symptom**:
```
Error: Index 'thoughtexpense-embeddings' not found
```

**Solution**: 
1. Check index name in Pinecone dashboard
2. Verify `PINECONE_INDEX_NAME` in `.env`
3. Make sure index creation completed successfully

---

### Error: "Invalid API key"

**Symptom**:
```
Error: Invalid Pinecone API key
```

**Solution**:
1. Check `PINECONE_API_KEY` in `.env`
2. Verify key is active in Pinecone dashboard
3. Regenerate key if needed

---

### Index Stuck in "Initializing"

**Symptom**: Index status shows "Initializing" for more than 5 minutes

**Solution**:
1. Wait a bit longer (can take up to 10 minutes)
2. Refresh the dashboard page
3. If still stuck, delete and recreate

---

## 📊 Dimension Comparison

| Model | Provider | Dimensions | Index Setting |
|-------|----------|-----------|---------------|
| text-embedding-3-small | OpenAI | 1536 | Old |
| text-embedding-3-large | OpenAI | 3072 | - |
| text-embedding-ada-002 | OpenAI | 1536 | - |
| **text-embedding-004** | **Gemini** | **768** | **New** ⭐ |
| embedding-001 | Gemini | 768 | Alternative |

---

## ✅ Verification Checklist

After updating your Pinecone index:

- [ ] Index name matches `.env` file
- [ ] Index dimensions are **768**
- [ ] Index metric is **cosine**
- [ ] Index status is **Ready**
- [ ] Backend server restarts successfully
- [ ] Can parse new expenses without errors
- [ ] No "dimension mismatch" errors in logs

---

## 🚀 After Update

Once your Pinecone index is updated:

1. **Restart Backend**
   ```bash
   cd backend
   npm run dev
   ```

2. **Test Parsing**
   ```bash
   curl -X POST http://localhost:3001/api/expenses/parse \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -d '{"rawInput":"coffee 5 dollars"}'
   ```

3. **Check Logs**
   - No errors about dimensions
   - Embedding upsert succeeds
   - Similar expense queries work

4. **Monitor Pinecone Dashboard**
   - Vector count increases as you add expenses
   - Query latency is good

---

## 💡 Pro Tips

1. **Use Serverless Pinecone** (if available)
   - No need to worry about pod types
   - Auto-scales
   - Pay per usage

2. **Set Up Monitoring**
   - Enable Pinecone metrics
   - Monitor vector count
   - Track query performance

3. **Backup Strategy**
   - Export vectors before deleting (if critical)
   - Keep expense data safe in PostgreSQL
   - Document your index configuration

4. **Test Environment First**
   - Create test index with 768 dimensions
   - Test with sample data
   - Verify everything works
   - Then update production

---

## 📝 Index Configuration Reference

### Recommended Settings

**For Development**:
```
Name: thoughtexpense-embeddings-dev
Dimensions: 768
Metric: cosine
Pod: p1.x1 (or serverless)
Environment: us-east-1 (or closest to you)
```

**For Production**:
```
Name: thoughtexpense-embeddings
Dimensions: 768
Metric: cosine
Pod: p2.x1 or serverless
Environment: us-east-1 (or closest to users)
Replicas: 2+ (for high availability)
```

---

## 🔗 Resources

- [Pinecone Console](https://app.pinecone.io)
- [Pinecone Documentation](https://docs.pinecone.io/)
- [Gemini Embeddings Guide](https://ai.google.dev/docs/embeddings_guide)
- [Vector Dimensions Explained](https://www.pinecone.io/learn/vector-embeddings/)

---

## ❓ Need Help?

### Common Questions

**Q: Can I keep both indexes?**  
A: Yes! Use different names and switch via `.env`

**Q: What if I want to go back to OpenAI?**  
A: Create another index with 1536 dimensions for OpenAI

**Q: Do I lose my expense data?**  
A: No! Expenses are in PostgreSQL, only vectors are in Pinecone

**Q: Can I migrate vectors instead of deleting?**  
A: Not easily - different dimensions require regeneration

**Q: How long to regenerate all embeddings?**  
A: Depends on expense count - ~1 second per expense

---

## 📞 Support

If you encounter issues:

1. Check Pinecone status page
2. Review error logs
3. Verify API keys
4. Try recreating the index
5. Contact Pinecone support if needed

---

**Status**: ⚠️ **Action Required**  
**Priority**: 🔴 **High** - Required for embeddings to work  
**Estimated Time**: ⏱️ 5 minutes

---

**Last Updated**: February 10, 2026
