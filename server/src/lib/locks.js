import { redis, ensureConnection } from "./redis.js";
import crypto from "crypto";

// Key for permanent status in Redis
const STATUS_KEY_PREFIX = "seat:status:";


export const HOLD_TTL_SECONDS = 120;

export async function createHold(seatId, { userId, bookingId, sectionId }) {
  await ensureConnection();
  const expiresAt = Date.now() + HOLD_TTL_SECONDS * 1000;
  const holdData = JSON.stringify({ userId, bookingId, sectionId, expiresAt });
  
  const result = await redis.set(
    `hold:seat:${seatId}`,
    holdData,
    "NX",
    "EX",
    HOLD_TTL_SECONDS
  );
  
  if (result === "OK") {
    // Create reverse mapping for payment lookup
    await redis.set(`booking:${bookingId}`, seatId, "EX", HOLD_TTL_SECONDS);
    return true;
  }
  
  return false;
}

/**
 * Get hold information for a seat
 */
export async function getHold(seatId) {
  await ensureConnection();
  const data = await redis.get(`hold:seat:${seatId}`);
  if (!data) return null;
  
  try {
    const hold = JSON.parse(data);
    // Double-check expiry (Redis TTL should handle this, but defensive)
    if (hold.expiresAt && hold.expiresAt < Date.now()) {
      await redis.del(`hold:seat:${seatId}`);
      return null;
    }
    return hold;
  } catch (err) {
    console.error("Failed to parse hold data:", err);
    return null;
  }
}

export async function getHoldByBookingId(bookingId) {
  await ensureConnection();
  const data = await redis.get(`booking:${bookingId}`);
  if (!data) return null;
  
  try {
    // Parse as array of seatIds (for multi-seat bookings)
    const seatIds = JSON.parse(data);
    const seats = [];
    
    // Handle both single seat (backward compat) and multiple seats
    const seatIdArray = Array.isArray(seatIds) ? seatIds : [seatIds];
    
    for (const seatId of seatIdArray) {
      const hold = await getHold(seatId);
      if (hold) {
        seats.push({
          seatId,
          userId: hold.userId,
          sectionId: hold.sectionId,
          bookingId: hold.bookingId,
        });
      }
    }
    
    if (seats.length === 0) return null;
    
    // Return first seat's data for single bookings, or array for multiple
    if (seats.length === 1) {
      return seats[0];
    }
    
    return {
      bookingId,
      userId: seats[0].userId,
      seats,
    };
  } catch (err) {
    // Fallback for old format (single seatId string)
    const seatId = data;
    const hold = await getHold(seatId);
    if (hold) {
      return {
        seatId,
        userId: hold.userId,
        sectionId: hold.sectionId,
        bookingId: hold.bookingId,
      };
    }
    return null;
  }
}

export async function releaseHold(seatId, userId) {
  await ensureConnection();
  const hold = await getHold(seatId);
  if (hold && hold.userId === userId) {
    await redis.del(`hold:seat:${seatId}`);
    await redis.del(`booking:${hold.bookingId}`);
    return true;
  }
  return false;
}

export async function isHeld(seatId) {
  const hold = await getHold(seatId);
  return Boolean(hold);
}

/**
 * Set seat as permanently BOOKED in Redis.
 * This acts as the immediate authority before DB sync.
 */
export async function setSeatBooked(seatId) {
  await ensureConnection();
  // Set status to BOOKED with a 24-hour expiry (86400 seconds)
  // This acts as a short-term authoritative cache that eventually expires,
  // falling back to the true database state after 24 hours.
  await redis.set(`${STATUS_KEY_PREFIX}${seatId}`, "BOOKED", "EX", 150);
}

/**
 * Get Redis-authoritative status (BOOKED or HOLD or null)
 */
export async function getRedisSeatStatus(seatId) {
  await ensureConnection();
  
  // Check permanent booked status first
  const booked = await redis.get(`${STATUS_KEY_PREFIX}${seatId}`);
  if (booked === "BOOKED") return "BOOKED";
  
  // Check temporary hold
  const hold = await getHold(seatId);
  if (hold) return "HOLD";
  
  return null;
}

/**
 * Optimized: Get status for multiple seats in minimal round trips
 * Uses pipelining to reduce latency
 */
export async function getAllSeatStatuses(seatIds) {
  await ensureConnection();
  
  const pipeline = redis.pipeline();
  
  // 1. Fetch permanent status for all seats
  for (const id of seatIds) {
    pipeline.get(`${STATUS_KEY_PREFIX}${id}`);
  }
  
  // 2. Fetch holds for all seats
  for (const id of seatIds) {
    pipeline.get(`hold:seat:${id}`);
  }
  
  const results = await pipeline.exec();
  const statuses = new Map(); // seatId -> status
  
  const numSeats = seatIds.length;
  
  for (let i = 0; i < numSeats; i++) {
    const seatId = seatIds[i];
    const [errBooked, booked] = results[i];
    const [errHold, holdData] = results[i + numSeats];
    
    if (booked === "BOOKED") {
      statuses.set(seatId, "BOOKED");
      continue;
    }
    
    if (holdData) {
      statuses.set(seatId, "HOLD");
    }
  }
  
  return statuses;
}


/**
 * Create multiple holds atomically (all or nothing) with single bookingId
 * Returns true if successful, false if any seat is unavailable
 */
export async function createMultipleHolds(seats, userId, bookingId) {
  await ensureConnection();
  const expiresAt = Date.now() + HOLD_TTL_SECONDS * 1000;
  const lockedSeats = [];

  try {
    // Try to lock all seats with the same bookingId
    for (const { seatId, sectionId } of seats) {
      const holdData = JSON.stringify({ userId, bookingId, sectionId, expiresAt });

      const result = await redis.set(
        `hold:seat:${seatId}`,
        holdData,
        "NX",
        "EX",
        HOLD_TTL_SECONDS
      );

      if (result !== "OK") {
        // Lock failed, rollback all previous locks
        for (const lockedSeatId of lockedSeats) {
          await redis.del(`hold:seat:${lockedSeatId}`);
        }
        await redis.del(`booking:${bookingId}`);
        return false;
      }

      lockedSeats.push(seatId);
    }

    // Create reverse mapping: bookingId -> array of seatIds
    await redis.set(
      `booking:${bookingId}`,
      JSON.stringify(lockedSeats),
      "EX",
      HOLD_TTL_SECONDS
    );

    return true;
  } catch (err) {
    // On error, rollback all locks
    for (const lockedSeatId of lockedSeats) {
      await redis.del(`hold:seat:${lockedSeatId}`);
    }
    await redis.del(`booking:${bookingId}`);
    throw err;
  }
}

/**
 * ===== GEO-TIME LOCKING (Traffic Shaping) =====
 * Unlock bookings region by region at predefined times
 * Reduces traffic spikes and improves fairness
 * 
 * Redis Key Pattern: geo:unlock:{city} → Unix timestamp (when booking opens)
 */

/**
 * Set the unlock time for a city
 * @param {string} city - City name (lowercase, e.g., 'ahmedabad', 'pune', 'delhi')
 * @param {number} unixTimestamp - Unix timestamp when booking opens for this city
 */
export async function setGeoUnlockTime(city, unixTimestamp) {
  await ensureConnection();
  await redis.set(`geo:unlock:${city.toLowerCase()}`, unixTimestamp.toString());
  console.log(`✓ Set unlock time for ${city} to ${new Date(unixTimestamp * 1000).toISOString()}`);
}

/**
 * Get the unlock time for a city
 * @param {string} city - City name
 * @returns {number|null} - Unix timestamp or null if not set
 */
export async function getGeoUnlockTime(city) {
  await ensureConnection();
  const timestamp = await redis.get(`geo:unlock:${city.toLowerCase()}`);
  return timestamp ? parseInt(timestamp) : null;
}

/**
 * Check if a city's booking window is unlocked
 * Returns true if current time >= unlock time
 * @param {string} city - City name
 * @returns {Object} - { isUnlocked: boolean, unlocksAt: timestamp, remainingSeconds: number }
 */
export async function isGeoUnlocked(city) {
  await ensureConnection();
  const unlockedTime = await getGeoUnlockTime(city);
  
  if (!unlockedTime) {
    // City not in system yet, assume unlocked
    return {
      isUnlocked: true,
      unlocksAt: null,
      remainingSeconds: 0,
    };
  }
  
  const now = Math.floor(Date.now() / 1000); // Current Unix timestamp (seconds)
  const isUnlocked = now >= unlockedTime;
  const remainingSeconds = Math.max(0, unlockedTime - now);
  
  return {
    isUnlocked,
    unlocksAt: unlockedTime,
    remainingSeconds,
  };
}

/**
 * Get unlock status for multiple cities
 * Useful for client UI to show countdown timers
 */
export async function getGeoUnlockStatus(cities) {
  await ensureConnection();
  const status = {};
  
  for (const city of cities) {
    const geoStatus = await isGeoUnlocked(city);
    status[city] = geoStatus;
  }
  
  return status;
}

/**
 * Get all configured city unlock times
 * Useful for admin dashboard
 */
export async function getAllGeoUnlockTimes() {
  await ensureConnection();
  const pattern = "geo:unlock:*";
  const keys = await redis.keys(pattern);
  
  const result = {};
  for (const key of keys) {
    const city = key.replace("geo:unlock:", "");
    const timestamp = await redis.get(key);
    result[city] = {
      timestamp: parseInt(timestamp),
      date: new Date(parseInt(timestamp) * 1000).toISOString(),
    };
  }
  
  return result;
}
