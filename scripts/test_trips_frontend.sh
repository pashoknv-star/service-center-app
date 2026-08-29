#!/bin/bash
set -e

# Test script for trips frontend functionality
# T4-fix test script

echo "=== T4-Fix: Trips Frontend Test Script ==="
echo "Starting at $(date)"

# Function to cleanup on exit
cleanup() {
    if [ ! -z "$PHP_PID" ]; then
        echo "Stopping PHP server (PID: $PHP_PID)..."
        kill $PHP_PID 2>/dev/null || true
    fi
    echo "Cleanup completed"
}

# Set trap for cleanup
trap cleanup EXIT

# Start PHP server on port 8091
echo "Starting PHP server on port 8091..."
php -S 127.0.0.1:8091 router.php &
PHP_PID=$!
echo "PHP server started with PID: $PHP_PID"

# Wait for server to start
sleep 2

# Test variables
BASE_URL="http://127.0.0.1:8091"
JAR_FILE="test_cookies.jar"
SUMMARY=""

echo "=== Test 1: Admin login ==="
echo "Logging in as admin..."
RESPONSE=$(curl -c $JAR_FILE -X POST "$BASE_URL/api/login.php" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"changeme"}')
HTTP_CODE=$(echo $RESPONSE | grep -o '"code":[0-9]*' | cut -d':' -f2 || echo "200")

# Check if login was successful by looking for "success": true
if echo "$RESPONSE" | grep -q '"success": true'; then
    echo "✓ Admin login successful"
    SUMMARY="$SUMMARY PASS"
else
    echo "✗ Admin login failed"
    echo "Response: $RESPONSE"
    SUMMARY="$SUMMARY FAIL"
    exit 1
fi

echo "=== Test 2: Create trip forecast ==="
echo "Creating trip forecast for emp_1 (2099-01-10 to 2099-01-12)..."
RESPONSE=$(curl -b $JAR_FILE -X POST "$BASE_URL/api/trips.php" \
    -H "Content-Type: application/json" \
    -d '{"title":"Test Trip","location":"Test Location","comment":"Test comment","participants":[{"employeeId":"emp_1","startDate":"2099-01-10","endDate":"2099-01-12"}]}')

# Extract trip ID using Python
TRIP_ID=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
trip = data.get('trip', {})
print(trip.get('id', ''))
" <<< "$RESPONSE" || echo "")

if echo "$RESPONSE" | grep -q '"success": true' && [ ! -z "$TRIP_ID" ]; then
    echo "✓ Trip forecast created successfully: $TRIP_ID"
    SUMMARY="$SUMMARY PASS"
else
    echo "✗ Trip forecast failed. Response: $RESPONSE"
    SUMMARY="$SUMMARY FAIL"
fi

echo "=== Test 3: Get trip ==="
if [ ! -z "$TRIP_ID" ]; then
    echo "Getting trip $TRIP_ID..."
    RESPONSE=$(curl -b $JAR_FILE -X GET "$BASE_URL/api/trips.php?id=$TRIP_ID")
    HTTP_CODE=$(echo "$RESPONSE" | grep -o '"code":[0-9]*' | cut -d':' -f2 || echo "200")
    
    if echo "$RESPONSE" | grep -q '"success": true'; then
        echo "✓ Get trip successful"
        SUMMARY="$SUMMARY PASS"
    else
        echo "✗ Get trip failed. Response: $RESPONSE"
        SUMMARY="$SUMMARY FAIL"
    fi
else
    echo "Skipping get trip test (no trip ID from previous test)"
    SUMMARY="$SUMMARY SKIP"
fi

echo "=== Test 4: Create vacation entry (conflict) ==="
echo "Creating vacation entry on 2099-02-11 for emp_1..."
RESPONSE=$(curl -s -b $JAR_FILE -X POST "$BASE_URL/api/save.php" \
    -H "Content-Type: application/json" \
    -d '{"year":2099,"entries":{"emp_1:2099-02-11":{"employeeId":"emp_1","date":"2099-02-11","status":"vacation","comment":"Test vacation","approvalStatus":"draft"}}}')

# Check for success first
if echo "$RESPONSE" | grep -q '"success": true'; then
    echo "Vacation created successfully"
    
    # Now try to create overlapping trip
    echo "Creating overlapping trip..."
    TRIP_RESPONSE=$(curl -s -b $JAR_FILE -X POST "$BASE_URL/api/trips.php" \
        -H "Content-Type: application/json" \
        -d '{"title":"Overlapping Trip","participants":[{"employeeId":"emp_1","startDate":"2099-02-11","endDate":"2099-02-11"}]}')
    
    if echo "$TRIP_RESPONSE" | grep -q '"error":[[:space:]]*"overlapping_entry"'; then
        echo "✓ Vacation conflict detected (overlapping_entry)"
        SUMMARY="$SUMMARY PASS"
    else
        echo "✗ Expected overlapping_entry error but got: $TRIP_RESPONSE"
        SUMMARY="$SUMMARY FAIL"
    fi
else
    echo "Vacation creation failed: $RESPONSE"
    SUMMARY="$SUMMARY FAIL"
fi

echo "=== Test 5: Version conflict ==="
if [ ! -z "$TRIP_ID" ]; then
    echo "Step 1: successful PUT (no entryVersion) -> version bumps to 2..."
    curl -s -o /dev/null -b $JAR_FILE -X PUT "$BASE_URL/api/trips.php?id=$TRIP_ID" \
        -H "Content-Type: application/json" \
        -d '{"title":"v2 probe"}'
    echo "Step 2: stale PUT with entryVersion=1 -> expect 409..."
    RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -b $JAR_FILE -X PUT "$BASE_URL/api/trips.php?id=$TRIP_ID" \
        -H "Content-Type: application/json" \
        -d '{"entryVersion":1,"title":"conflict-probe"}')
    
    HTTP_CODE=$(echo "$RESPONSE" | grep -o 'HTTP_CODE:[0-9]*' | cut -d':' -f2)
    
    if [ "$HTTP_CODE" = "409" ]; then
        echo "✓ Version conflict detected (409 version_conflict)"
        SUMMARY="$SUMMARY PASS"
    else
        echo "✗ Expected 409 version conflict but got: $HTTP_CODE"
        SUMMARY="$SUMMARY FAIL"
    fi
else
    echo "Skipping version conflict test (no trip ID)"
    SUMMARY="$SUMMARY SKIP"
fi

echo "=== Test 6: Viewer read-only ==="
JAR_VIEWER="/tmp/trips_test_viewer.jar"
RESPONSE=$(curl -s -c $JAR_VIEWER -X POST "$BASE_URL/api/login.php" \
    -H "Content-Type: application/json" \
    -d '{"username":"viewer_test","password":"changeme"}')

if echo "$RESPONSE" | grep -q '"success": true'; then
    echo "Viewer logged in, testing trip creation (should be 403)..."
    VRESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -b $JAR_VIEWER -X POST "$BASE_URL/api/trips.php" \
        -H "Content-Type: application/json" \
        -d '{"title":"Viewer Trip","participants":[{"employeeId":"emp_1","startDate":"2099-04-01","endDate":"2099-04-02"}]}')
    VHTTP=$(echo "$VRESPONSE" | grep -o 'HTTP_CODE:[0-9]*' | cut -d':' -f2)
    if [ "$VHTTP" = "403" ]; then
        echo "✓ Viewer POST forbidden (403)"
        SUMMARY="$SUMMARY PASS"
    else
        echo "✗ Viewer POST returned $VHTTP (expected 403)"
        SUMMARY="$SUMMARY FAIL"
    fi
else
    echo "✗ Viewer login failed: $RESPONSE"
    SUMMARY="$SUMMARY FAIL"
fi

echo "=== Test 7: Delete trip ==="
if [ ! -z "$TRIP_ID" ]; then
    echo "Deleting trip $TRIP_ID..."
    RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -b $JAR_FILE -X DELETE "$BASE_URL/api/trips.php?id=$TRIP_ID")
    HTTP_CODE=$(echo "$RESPONSE" | grep -o 'HTTP_CODE:[0-9]*' | cut -d':' -f2)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo "✓ Trip deleted successfully"
        SUMMARY="$SUMMARY PASS"
    else
        echo "✗ Delete trip failed. HTTP: $HTTP_CODE"
        SUMMARY="$SUMMARY FAIL"
    fi
else
    echo "Skipping delete trip test (no trip ID)"
    SUMMARY="$SUMMARY SKIP"
fi

# Generate final summary
echo ""
echo "=== TEST SUMMARY ==="
echo "Tests completed at $(date)"
echo "Results: $SUMMARY"

# Count passes
PASSES=$(echo $SUMMARY | tr ' ' '\n' | grep -c "PASS")
TOTAL=$(echo $SUMMARY | tr ' ' '\n' | grep -vc "SKIP" || echo "0")

echo "Pass rate: $PASSES/$TOTAL"

# Exit code
if [ "$PASSES" -eq "$TOTAL" ]; then
    echo "✓ ALL TESTS PASSED"
    exit 0
else
    echo "✗ SOME TESTS FAILED"
    exit 1
fi