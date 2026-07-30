#!/bin/bash
set -e

echo "=== Running Docker Ports CLI Integration Tests ==="

# Clean any previous test config artifacts
rm -f .docker-ports-config.json
rm -rf ./tmp-test-db

echo "Testing Global Options..."
node index.js -v
node index.js --help > /dev/null

echo "Testing Configuration Boundaries..."
node index.js start 3000 20
node index.js path ./tmp-test-db

echo "Testing Port Allocation Routines..."
node index.js add service-alpha
node index.js add service-beta "Beta microservice worker"
node index.js add manual-service 9090 "Manual entry"

echo "Listing Registered Entries..."
node index.js list

echo "Testing Next Port Calculations..."
NEXT_VAL=$(node index.js next)
echo "Next free port returned: $NEXT_VAL"

echo "Testing Update Operations..."
node index.js update service-alpha 3500 "Repositioned Service Alpha"

echo "Testing Removal Operations..."
node index.js del service-beta

echo "Final Verification Output Listing..."
node index.js list

# Cleanup test directory structures
rm -f .docker-ports-config.json
rm -rf ./tmp-test-db

echo "=== All Tests Passed Successfully ==="
