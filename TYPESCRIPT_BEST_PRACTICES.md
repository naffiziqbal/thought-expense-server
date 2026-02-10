# TypeScript Best Practices & Type Casting Guide

This document outlines the TypeScript patterns, type casting strategies, and best practices used in the ThoughtExpense backend.

## Table of Contents
1. [Type Assertions](#type-assertions)
2. [Async Handler Patterns](#async-handler-patterns)
3. [Request/Response Types](#requestresponse-types)
4. [Environment Variables](#environment-variables)
5. [Database Types](#database-types)
6. [Third-Party Library Types](#third-party-library-types)

---

## Type Assertions

### Non-Null Assertion (`!`)
Used when you're certain a value is not null/undefined.

```typescript
// ✅ Good - User is guaranteed by auth middleware
const userId = req.user!.id;
const currency = req.user!.currency;

// ❌ Bad - Use optional chaining for potentially undefined values
const userId = req.user?.id; // Returns undefined if user is null
```

### Type Assertion (`as`)
Used to tell TypeScript to treat a value as a specific type.

```typescript
// ✅ Good - Explicit type casting
const secret = process.env.JWT_SECRET as string;
const options = { expiresIn: '7d' } as SignOptions;

// ✅ Good - Query parameters are always strings
const limit = parseInt(req.query.limit as string);
const startDate = new Date(req.query.startDate as string);

// ❌ Bad - Unsafe, may cause runtime errors
const secret = process.env.JWT_SECRET as number; // Wrong type!
```

### Generic Types
Used for functions that work with multiple types.

```typescript
// ✅ Good - Cache function with generic return type
export const getCache = async <T = any>(key: string): Promise<T | null> => {
  const data = await client.get(key);
  return data ? JSON.parse(data) as T : null;
};

// Usage with type inference
const cached = await getCache<ExpenseData>(cacheKey);
```

---

## Async Handler Patterns

### Explicit Return Types
All async handlers should have explicit `Promise<void>` return type.

```typescript
// ✅ CORRECT - Explicit Promise<void> return type
export const getExpenses = asyncHandler(
  async (req: AuthRequest, res: Response): Promise<void> => {
    const cached = await getCache(cacheKey);
    if (cached) {
      res.json({ data: cached });
      return; // Explicit void return
    }
    
    // ... rest of logic
    res.json({ data: result });
  }
);

// ❌ WRONG - No return type, TypeScript complains
export const getExpenses = asyncHandler(async (req, res) => {
  if (cached) {
    return res.json({ data: cached }); // Error: Not all paths return
  }
});
```

### Early Returns
Use explicit `return;` for void functions with early exits.

```typescript
// ✅ Good - Explicit void return
if (condition) {
  res.status(400).json({ error: 'Bad request' });
  return; // Clear exit point
}

// ❌ Bad - Implicit return
if (condition) {
  return res.status(400).json({ error: 'Bad request' }); // Confusing
}
```

---

## Request/Response Types

### Extended Request Interface
Custom interface for authenticated requests.

```typescript
// Define in middleware/auth.middleware.ts
export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string | null;
    currency: string;
    createdAt: Date;
  };
}

// Usage in controllers
export const getExpenses = asyncHandler(
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id; // Non-null assertion safe here
  }
);
```

### Query Parameters
Always cast query parameters to appropriate types.

```typescript
// ✅ Good - Explicit casting with defaults
const { 
  startDate, 
  endDate, 
  category, 
  limit = '50',    // String default
  offset = '0' 
} = req.query;

const limitNum = parseInt(limit as string);
const offsetNum = parseInt(offset as string);

// Date handling
if (startDate) {
  where.date.gte = new Date(startDate as string);
}
```

### Response Types
TypeScript infers response types from `res.json()`.

```typescript
// ✅ Good - Clear response structure
res.json({
  success: true,
  data: {
    expenses: expenses,
    pagination: {
      total: number,
      hasMore: boolean
    }
  }
});
```

---

## Environment Variables

### Type Assertion Pattern
Always cast environment variables to expected types.

```typescript
// ✅ Good - Explicit string assertion
const port = process.env.PORT || 3001;
const secret = process.env.JWT_SECRET as string;
const apiKey = process.env.OPENAI_API_KEY as string;

// ✅ Good - With fallback
const threshold = parseFloat(
  process.env.CLASSIFICATION_CONFIDENCE_THRESHOLD || '0.7'
);

// ❌ Bad - No type safety
const secret = process.env.JWT_SECRET; // Could be undefined
```

### Environment Variable Validation
Validate critical environment variables at startup.

```typescript
// ✅ Good - Validate required env vars
const requiredEnvVars = [
  'JWT_SECRET',
  'DATABASE_URL',
  'OPENAI_API_KEY'
];

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
});
```

---

## Database Types

### Prisma Generated Types
Prisma generates TypeScript types automatically.

```typescript
import { Expense, User, Insight } from '@prisma/client';

// ✅ Good - Use Prisma types
const expense: Expense = await prisma.expense.findUnique({
  where: { id }
});

// ✅ Good - Partial types for updates
const updates: Partial<Expense> = req.body;
```

### Custom Database Interfaces
For complex queries, define custom interfaces.

```typescript
// ✅ Good - Interface for custom query result
interface ExpenseSummary {
  totalSpent: number;
  currency: string;
  byCategory: Record<string, number>;
  percentages: Record<string, string>;
  topCategories: string[];
  transactionCount: number;
}

// Usage
const summary: ExpenseSummary = {
  totalSpent: parseFloat(total.toFixed(2)),
  currency: user.currency,
  byCategory,
  percentages,
  topCategories,
  transactionCount: expenses.length
};
```

### Where Clause Typing
Use `any` for dynamic where clauses (Prisma limitation).

```typescript
// ✅ Acceptable - Dynamic where clause
const where: any = { userId };

if (startDate || endDate) {
  where.date = {};
  if (startDate) where.date.gte = new Date(startDate as string);
  if (endDate) where.date.lte = new Date(endDate as string);
}
```

---

## Third-Party Library Types

### JWT Token Generation
Handle JWT types carefully.

```typescript
import jwt, { SignOptions } from 'jsonwebtoken';

// ✅ Good - Explicit type assertion for options
const generateToken = (userId: string): string => {
  const secret = process.env.JWT_SECRET as string;
  const options = {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  };
  
  return jwt.sign({ id: userId }, secret, options as SignOptions);
};
```

### JWT Verification
Type the decoded payload.

```typescript
interface JwtPayload {
  id: string;
}

// ✅ Good - Type assertion for decoded token
const decoded = jwt.verify(token, secret) as JwtPayload;
const userId = decoded.id; // Type-safe access
```

### OpenAI Response Handling
Always validate and type OpenAI responses.

```typescript
// ✅ Good - Validation + typing
const response = await openai.chat.completions.create({...});
const content = response.choices[0].message.content;

if (!content) {
  throw new Error('No content returned from OpenAI');
}

const parsed = JSON.parse(content);
// Validate structure before using
```

### Express Validator
Use proper typing for validation results.

```typescript
import { validationResult, ValidationError } from 'express-validator';

// ✅ Good - Type-safe error handling
const errors = validationResult(req);
if (!errors.isEmpty()) {
  res.status(400).json({
    success: false,
    errors: errors.array().map(err => ({
      field: err.type === 'field' ? err.path : 'unknown',
      message: err.msg
    }))
  });
  return;
}
```

---

## Common Patterns

### Unused Parameters
Prefix with underscore to indicate intentional non-use.

```typescript
// ✅ Good - Underscore prefix
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ❌ Bad - TypeScript error
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' }); // Error: 'req' declared but never used
});
```

### Error Handling
Type custom error classes properly.

```typescript
// ✅ Good - Custom error class
export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Usage with type safety
throw new AppError('User not found', 404);
```

### Type Guards
Use type guards for runtime type checking.

```typescript
// ✅ Good - Type guard function
function isValidExpense(obj: any): obj is ParsedExpense {
  return (
    typeof obj.description === 'string' &&
    typeof obj.amount === 'number' &&
    typeof obj.category === 'string'
  );
}

// Usage
if (isValidExpense(parsed)) {
  // TypeScript knows parsed is ParsedExpense here
  console.log(parsed.amount);
}
```

---

## Type Safety Checklist

Before committing code, ensure:

- [ ] All function signatures have explicit return types
- [ ] Environment variables are properly typed
- [ ] Query parameters are cast to correct types
- [ ] Third-party library responses are validated
- [ ] Custom interfaces are used for complex data structures
- [ ] Non-null assertions (`!`) are only used when guaranteed
- [ ] Type assertions (`as`) are used sparingly and safely
- [ ] `any` type is avoided unless absolutely necessary
- [ ] Build passes without errors: `npm run build`
- [ ] Type check passes: `npx tsc --noEmit`

---

## Debugging Type Errors

### Common Issues

1. **"Not all code paths return a value"**
   - Solution: Add explicit `Promise<void>` return type
   - Use `return;` after `res.json()` calls

2. **"Type X is not assignable to type Y"**
   - Solution: Use type assertion with `as`
   - Ensure the assertion is safe

3. **"Property does not exist on type"**
   - Solution: Extend the interface or use type assertion
   - Check if property is optional (`?`)

4. **"Cannot find module"**
   - Solution: Check import paths use `.ts` extension in source
   - Verify `tsconfig.json` paths are correct

---

## Summary

✅ **Always use explicit types**
✅ **Cast environment variables**
✅ **Type async handlers properly**
✅ **Validate third-party responses**
✅ **Use interfaces for complex data**
✅ **Prefix unused parameters with `_`**
✅ **Add JSDoc comments for clarity**
✅ **Run type checks before committing**

Following these practices ensures type-safe, maintainable, and production-ready code! 🚀
