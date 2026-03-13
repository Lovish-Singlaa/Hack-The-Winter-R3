import { Pool } from "pg";
import { startWorker } from "./worker.js";

// Initialize Postgres connection pool
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  // Always use SSL for remote databases (Neon, Vercel) even in local dev
  ssl: process.env.POSTGRES_URL && process.env.POSTGRES_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

/**
 * Ensure tables exist and seed data
 */
export async function initDB() {
  await ensureTables();
  await seedSeats();
  
  // Start the background worker (Singleton)
  startWorker();
  
  console.log("✓ PostgreSQL initialized");
}

async function ensureTables() {
  const client = await pool.connect();
  try {
    // Seats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS Seats (
        seat_id VARCHAR(50) PRIMARY KEY,
        section_id VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL
      )
    `);

    // Bookings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS Bookings (
        booking_id VARCHAR(255) PRIMARY KEY,
        seat_id VARCHAR(50) NOT NULL,
        section_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Payments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS Payments (
        idempotency_key VARCHAR(255) PRIMARY KEY,
        booking_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log("✓ PostgreSQL tables checked/created");
  } catch (err) {
    console.error("Error creating tables:", err);
    throw err;
  } finally {
    client.release();
  }
}

async function seedSeats() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT COUNT(*) FROM Seats");
    if (parseInt(rows[0].count) > 0) return;

    console.log("Seeding seats...");
    const sections = { A: 24, B: 40, C: 60 };
    
    await client.query("BEGIN");
    
    for (const [sectionId, count] of Object.entries(sections)) {
      for (let i = 1; i <= count; i++) {
        await client.query(
          "INSERT INTO Seats (seat_id, section_id, status) VALUES ($1, $2, $3) ON CONFLICT (seat_id) DO NOTHING",
          [`${sectionId}${i}`, sectionId, "AVAILABLE"]
        );
      }
    }
    
    await client.query("COMMIT");
    console.log("✓ Seeded seats table");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error seeding seats:", err);
    throw err;
  } finally {
    client.release();
  }
}

export async function getAllSeats() {
  const { rows } = await pool.query(
    "SELECT * FROM Seats ORDER BY section_id, LENGTH(seat_id), seat_id"
  );
  return rows;
}

export async function getSeat(seatId) {
  const { rows } = await pool.query(
    "SELECT * FROM Seats WHERE seat_id = $1",
    [seatId]
  );
  return rows[0] || null;
}

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

export async function getBooking(bookingId) {
  const { rows } = await pool.query(
    "SELECT * FROM Bookings WHERE booking_id = $1",
    [bookingId]
  );
  return rows[0] || null;
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
