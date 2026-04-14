#!/bin/bash
set -e

cd "$(dirname "$0")/../.."

echo "🦞 OmbRouter Edge Case Test Suite"
echo ""

# Build the test image
echo "🐳 Building Docker test environment..."
docker build -f test/docker/Dockerfile.edge-cases -t ombrouter-edge-cases .

echo ""
echo "🧪 Running edge case tests..."

# Run with network access for x402 testing
docker run --rm \
    --network host \
    -e BLOCKRUN_API_URL="${BLOCKRUN_API_URL:-https://api.blockrun.ai/v1}" \
    ombrouter-edge-cases

echo ""
echo "✅ Edge case tests completed!"
