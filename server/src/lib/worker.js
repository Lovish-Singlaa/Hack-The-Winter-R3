/**
 * Background Worker
 * Consumes messages from Mock SQS and updates the database
 */
import { mockSQS } from "./queue.js";
import { createBooking, savePayment } from "./db.js";
import { releaseHold } from "./locks.js";

const POLLING_INTERVAL = 1000; // Poll every 1 second

async function processMessage(message) {
  try {
    const body = JSON.parse(message.Body);
    
    if (body.type === "BOOKING_CONFIRMED") {
      const { bookingId, seatId, sectionId, userId, idempotencyKey } = body.data;
      
      console.log(`[Worker] Processing booking ${bookingId} for seat ${seatId}`);
      
      // 1. Create booking in Postgres
      await createBooking({
        bookingId,
        seatId,
        sectionId,
        userId
      });
      
      // 2. Release the HOLD lock in Redis (since it's now permanently BOOKED)
      // Note: The permanent BOOKED state is already set in Redis by the API before queuing
      await releaseHold(seatId, userId);
      
      // 3. Mark payment as CONFIRMED (if not already)
      await savePayment({
        bookingId,
        status: "CONFIRMED",
        idempotencyKey
      });
      
      // 4. Acknowledge message (Delete from SQS)
      if (message.ReceiptHandle) {
        await mockSQS.deleteMessage(message.ReceiptHandle);
      }
      
      console.log(`[Worker] Successfully processed booking ${bookingId}`);
    }
  } catch (err) {
    console.error(`[Worker] Failed to process message:`, err);
    // In real SQS, we DON'T delete here so it becomes visible again after timeout
  }
}

let started = false;

export function startWorker() {
  if (started) return;
  started = true;
  
  console.log("✓ Worker started. Polling for messages...");
  
  const poll = async () => {
    try {
      const { Messages } = await mockSQS.receiveMessage(5);
      
      if (Messages && Messages.length > 0) {
        // Process sequentially to be safe
        for (const message of Messages) {
          await processMessage(message);
        }
      }
    } catch (err) {
      console.error("Worker polling error:", err);
    } finally {
      // Schedule next poll only after current one finishes
      setTimeout(poll, POLLING_INTERVAL);
    }
  };

  poll();
}
