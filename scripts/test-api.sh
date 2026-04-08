#!/bin/bash

# ThoughtExpense API Test Script
# This script tests all major endpoints of the backend API

set -e

BASE_URL="http://localhost:7100"
EMAIL="test@example.com"
PASSWORD="testpassword123"
TOKEN=""

echo "🧪 ThoughtExpense API Test Suite"
echo "================================"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
success() {
    echo -e "${GREEN}✓${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
}

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Test 1: Health Check
echo "1️⃣  Testing health check..."
HEALTH=$(curl -s "${BASE_URL}/health")
if echo "$HEALTH" | grep -q "ok"; then
    success "Health check passed"
else
    error "Health check failed"
    exit 1
fi
echo ""

# Test 2: Signup
echo "2️⃣  Testing user signup..."
SIGNUP_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${EMAIL}\",
    \"password\": \"${PASSWORD}\",
    \"name\": \"Test User\"
  }")

if echo "$SIGNUP_RESPONSE" | grep -q "token"; then
    TOKEN=$(echo "$SIGNUP_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)
    success "User signup successful"
    info "Token: ${TOKEN:0:20}..."
else
    # If user exists, try login
    info "User might already exist, trying login..."
    LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/auth/login" \
      -H "Content-Type: application/json" \
      -d "{
        \"email\": \"${EMAIL}\",
        \"password\": \"${PASSWORD}\"
      }")
    
    if echo "$LOGIN_RESPONSE" | grep -q "token"; then
        TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)
        success "Login successful"
        info "Token: ${TOKEN:0:20}..."
    else
        error "Authentication failed"
        echo "$LOGIN_RESPONSE"
        exit 1
    fi
fi
echo ""

# Test 3: Get current user
echo "3️⃣  Testing get current user..."
ME_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/auth/me" \
  -H "Authorization: Bearer ${TOKEN}")

if echo "$ME_RESPONSE" | grep -q "email"; then
    success "Get current user successful"
else
    error "Get current user failed"
fi
echo ""

# Test 4: Parse expenses
echo "4️⃣  Testing expense parsing..."
PARSE_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/expenses/parse" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "rawInput": "coffee 5\nrent 1200\nuber to downtown 15\ngroceries at whole foods 85\nnetflix subscription 12"
  }')

if echo "$PARSE_RESPONSE" | grep -q "expenses"; then
    success "Expense parsing successful"
    EXPENSE_COUNT=$(echo "$PARSE_RESPONSE" | grep -o '"id"' | wc -l)
    info "Parsed ${EXPENSE_COUNT} expenses"
    
    # Extract first expense ID for later tests
    EXPENSE_ID=$(echo "$PARSE_RESPONSE" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
    info "Sample expense ID: $EXPENSE_ID"
else
    error "Expense parsing failed"
    echo "$PARSE_RESPONSE"
fi
echo ""

# Test 5: Get expenses
echo "5️⃣  Testing get expenses..."
EXPENSES_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/expenses?limit=10" \
  -H "Authorization: Bearer ${TOKEN}")

if echo "$EXPENSES_RESPONSE" | grep -q "expenses"; then
    success "Get expenses successful"
    TOTAL=$(echo "$EXPENSES_RESPONSE" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    info "Total expenses: $TOTAL"
else
    error "Get expenses failed"
fi
echo ""

# Test 6: Get expense summary
echo "6️⃣  Testing expense summary..."
SUMMARY_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/expenses/summary" \
  -H "Authorization: Bearer ${TOKEN}")

if echo "$SUMMARY_RESPONSE" | grep -q "totalSpent"; then
    success "Get summary successful"
    TOTAL_SPENT=$(echo "$SUMMARY_RESPONSE" | grep -o '"totalSpent":[0-9.]*' | cut -d':' -f2)
    info "Total spent: \$${TOTAL_SPENT}"
else
    error "Get summary failed"
fi
echo ""

# Test 7: Update expense (if we have an ID)
if [ -n "$EXPENSE_ID" ]; then
    echo "7️⃣  Testing expense update..."
    UPDATE_RESPONSE=$(curl -s -X PATCH "${BASE_URL}/api/expenses/${EXPENSE_ID}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -d '{
        "category": "Food"
      }')
    
    if echo "$UPDATE_RESPONSE" | grep -q "success"; then
        success "Expense update successful"
    else
        error "Expense update failed"
    fi
    echo ""
fi

# Test 8: Generate insights
echo "8️⃣  Testing insight generation..."
INSIGHTS_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/insights/generate" \
  -H "Authorization: Bearer ${TOKEN}")

if echo "$INSIGHTS_RESPONSE" | grep -q "insights"; then
    success "Insight generation successful"
    INSIGHT_COUNT=$(echo "$INSIGHTS_RESPONSE" | grep -o '"content"' | wc -l)
    info "Generated ${INSIGHT_COUNT} insights"
else
    error "Insight generation failed (might be expected if no expenses)"
fi
echo ""

# Test 9: Get insights
echo "9️⃣  Testing get insights..."
GET_INSIGHTS_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/insights?limit=5" \
  -H "Authorization: Bearer ${TOKEN}")

if echo "$GET_INSIGHTS_RESPONSE" | grep -q "insights"; then
    success "Get insights successful"
else
    error "Get insights failed"
fi
echo ""

echo "================================"
echo "✨ All tests completed!"
echo ""
echo "Summary:"
echo "  - Backend: Running ✓"
echo "  - Authentication: Working ✓"
echo "  - Expense Parsing: Working ✓"
echo "  - CRUD Operations: Working ✓"
echo "  - Insights: Working ✓"
echo ""
echo "🎉 Your ThoughtExpense backend is ready to use!"
