import { Pool } from "pg";

// Initialize Postgres connection pool
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

export async function createBooking({ bookingId, seatId, sectionId, userId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Update Seat status
    await client.query(
      "UPDATE Seats SET status = $1 WHERE seat_id = $2",
      ["BOOKED", seatId]
    );

    // Create Booking
    await client.query(
      "INSERT INTO Bookings (booking_id, seat_id, section_id, user_id, status) VALUES ($1, $2, $3, $4, $5)",
      [bookingId, seatId, sectionId, userId, "BOOKED"]
    );

    await client.query("COMMIT");
    return { bookingId, seatId, sectionId, userId, status: "BOOKED" };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Transaction failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

export async function getPaymentByKey(idempotencyKey) {
  const { rows } = await pool.query(
    "SELECT * FROM Payments WHERE idempotency_key = $1",
    [idempotencyKey]
  );
  return rows[0] || null;
}

export async function savePayment({ bookingId, status, idempotencyKey }) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO Payments (idempotency_key, booking_id, status) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (idempotency_key) DO NOTHING 
       RETURNING *`,
      [idempotencyKey, bookingId, status]
    );
    
    // If no rows were returned, the key already existed
    if (rows.length === 0) {
      return await getPaymentByKey(idempotencyKey);
    }
    
    return rows[0];
  } catch (err) {
    console.error("Error saving payment:", err);
    throw err;
  } finally {
    client.release();
  }
}
