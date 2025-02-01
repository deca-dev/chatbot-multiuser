POST http://localhost:3009/vendors/register
{"name": "Vendor 1"}


GET http://localhost:3009/vendors/{vendorId}/qr


POST http://localhost:3009/messages/send
{
    "vendorId": "...",
    "targetNumber": "52155xxxxxxxx",
    "message": "Test message"
}



<!-- Register a vendor: You'll get a vendorId and port. -->

curl -X POST http://localhost:3009/vendors/register \
-H "Content-Type: application/json" \
-d '{"name": "Test Vendor"}'

<!-- Get QR -->
curl http://localhost:{port}/vendors/{vendorId}/qr

<!-- Scan QR in Whatsapp -->

<!-- Check Vendor status -->
curl http://localhost:3009/vendors

<!-- Send message to specific number: -->

bashCopycurl -X POST http://localhost:3009/messages/send \
-H "Content-Type: application/json" \
-d '{
    "vendorId": "YOUR_VENDOR_ID",
    "targetNumber": "1234567890",
    "message": "Test message"
}'

<!-- Broadcast -->
// Broadcast same message from all connected vendors
POST /messages/broadcast
{
   "targetNumber": "52155xxxxxxx", 
   "message": "Broadcast message"
}

<!-- Check conversations: -->

http://localhost:3009/conversations/{vendorId}/{targetNumber}

<!-- Monitor health: -->

http://localhost:3009/health