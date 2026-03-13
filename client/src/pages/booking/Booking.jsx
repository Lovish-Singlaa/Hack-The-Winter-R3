import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './Booking.module.scss';
import { eventData, seatLayout, transformSeatsData } from '../../data/mockData';
import { errorToast, successToast, infoToast } from '../../lib/toast';
import { useSeats } from '../../api';
import { socket } from "../../lib/socket";


// User ID - in production, get from auth
// Using a fixed ID for demo purposes
const USER_ID = "4";

const MAX_SEATS = 4;

const Booking = () => {
  const navigate = useNavigate();
  const { seatsLoading, bookingLoading, getSeats, bookSeat } = useSeats();

  const [seats, setSeats] = useState(null);
  const [selectedSeats, setSelectedSeats] = useState([]); // Array of {seat, section}
  const [isLoading, setIsLoading] = useState(false);
  const [loadingSeatId, setLoadingSeatId] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [city, setCity] = useState('');

  // Fetch seats on mount
  useEffect(() => {
    fetchSeats();
  }, []);

  const updateSeatStatus = (seatId, newStatus) => {
    setSeats((prevSeats) => {
      if (!prevSeats || !prevSeats.sections) return prevSeats;

      const newSeats = { ...prevSeats };
      newSeats.sections = newSeats.sections.map((section) => ({
        ...section,
        rows: section.rows.map((row) =>
          row.map((seat) =>
            seat.seatId === seatId ? { ...seat, status: newStatus } : seat
          )
        ),
      }));
      return newSeats;
    });
  };

  // ✅ SOCKET: Listen for realtime seat updates (MUST be top-level)
  useEffect(() => {
    console.log("[Socket] init listeners");

    socket.on("connect", () => {
      console.log("[Socket] Connected:", socket.id);
    });

    socket.on("seat:update", (data) => {
      console.log("[Socket] seat:update", data);

      const { seatId, status } = data;
      if (!seatId || !status) return;

      // backend emits HELD, UI uses HOLD
      const uiStatus = status === "HELD" ? "HOLD" : status;

      updateSeatStatus(seatId, uiStatus);

      // If seat is not available, remove it from selected list
      if (uiStatus !== "AVAILABLE") {
        setSelectedSeats((prev) => prev.filter((s) => s.seat.seatId !== seatId));
      }
    });

    socket.on("disconnect", () => {
      console.log("[Socket] Disconnected");
    });

    return () => {
      socket.off("connect");
      socket.off("seat:update");
      socket.off("disconnect");
    };
  }, []);


  const fetchSeats = () => {
    getSeats((data, error) => {
      if (error) {
        console.error("[Booking] Error fetching seats:", error);
        // Fallback to mock data
        setSeats(seatLayout);
        setInitialLoading(false);
        return;
      }


      // Transform API response to UI format
      const transformedData = transformSeatsData(data.sections);

      setSeats(transformedData);
      setInitialLoading(false);
    });
  };

  // Handle individual seat click - toggle selection
  const handleSeatClick = (seat, section) => {
    if (seat.status !== 'AVAILABLE' || isLoading || bookingLoading) return;

    const isAlreadySelected = selectedSeats.some(s => s.seat.seatId === seat.seatId);

    if (isAlreadySelected) {
      // Deselect the seat
      setSelectedSeats(prev => prev.filter(s => s.seat.seatId !== seat.seatId));
    } else {
      // Check if max seats reached
      if (selectedSeats.length >= MAX_SEATS) {
        errorToast(`You can select maximum ${MAX_SEATS} seats at a time`);
        return;
      }
      // Check if same section (all selected seats must be from same section)
      if (selectedSeats.length > 0 && selectedSeats[0].section.sectionId !== section.sectionId) {
        errorToast('Please select seats from the same section');
        return;
      }
      // Add to selection
      setSelectedSeats(prev => [...prev, { seat, section }]);
      infoToast(`${seat.seatId} selected (${selectedSeats.length + 1}/${MAX_SEATS})`);
    }
  };

  // Confirm and book selected seats
  const handleConfirmBooking = () => {
    if (!city) {
      errorToast('Please select a city first');
      return;
    }
    if (selectedSeats.length === 0 || isLoading || bookingLoading) return;

    const section = selectedSeats[0].section;
    const seatsToBook = selectedSeats.map(s => ({
      seatId: s.seat.seatId,
      sectionId: s.section.sectionId,
    }));

    setIsLoading(true);
    infoToast(`Reserving ${selectedSeats.length} seat(s)...`);

    bookSeat(
      {
        seats: seatsToBook,
        userId: USER_ID,
        city,
      },
      (data, error) => {
        if (error) {
          console.error("[Booking] Book seats error:", error);
          if (error?.error === "SEAT_ALREADY_TAKEN") {
            // Update the taken seat status
            if (error.seatId) {
              updateSeatStatus(error.seatId, 'BOOKED');
              setSelectedSeats(prev => prev.filter(s => s.seat.seatId !== error.seatId));
            }
          }
          setIsLoading(false);
          return;
        }

        successToast(`${selectedSeats.length} seat(s) reserved!`);

        // Navigate to payment with booking info
        navigate('/payment', {
          state: {
            seats: data.seats || seatsToBook,
            section: section,
            bookingId: data.bookingId,
            expiresIn: data.expiresIn,
            userId: USER_ID,
            count: data.count || selectedSeats.length,
            city,
          },
        });

        setSelectedSeats([]);
        setIsLoading(false);
      }
    );
  };

  // Clear selection
  const handleClearSelection = () => {
    setSelectedSeats([]);
  };

  // Check if a seat is selected
  const isSeatSelected = (seatId) => {
    return selectedSeats.some(s => s.seat.seatId === seatId);
  };

  // Handle section-based booking (auto-assign)
  const handleSectionBook = async (section) => {
    if (!city) {
      errorToast('Please select a city first');
      return;
    }
    if (isLoading || bookingLoading) return;

    // Find all available seats in this section
    const availableSeats = [];
    section.rows.forEach((row) => {
      row.forEach((seat) => {
        if (seat.status === 'AVAILABLE') {
          availableSeats.push(seat);
        }
      });
    });

    if (availableSeats.length === 0) {
      errorToast('No seats available in this section');
      return;
    }

    // Randomly pick one
    const randomSeat = availableSeats[Math.floor(Math.random() * availableSeats.length)];

    setIsLoading(true);
    setLoadingSeatId(randomSeat.seatId);
    infoToast(`Reserving seat ${randomSeat.seatId}...`);

    bookSeat(
      {
        seats: [{ seatId: randomSeat.seatId, sectionId: section.sectionId }],
        userId: USER_ID,
        city,
      },
      (data, error) => {
        if (error) {
          console.error("[Booking] Quick book error:", error);
          if (error?.error === "SEAT_ALREADY_TAKEN") {
            updateSeatStatus(randomSeat.seatId, 'BOOKED');
          }
          setIsLoading(false);
          setLoadingSeatId(null);
          return;
        }

        successToast(`Seat ${randomSeat.seatId} reserved!`);

        navigate('/payment', {
          state: {
            seats: data.seats || [{ seatId: randomSeat.seatId, sectionId: section.sectionId }],
            section: section,
            bookingId: data.bookingId,
            expiresIn: data.expiresIn,
            userId: USER_ID,
            count: data.count || 1,
            city,
          },
        });

        setIsLoading(false);
        setLoadingSeatId(null);
      }
    );
  };

  // Get seat class based on status
  const getSeatClass = (seat) => {
    let classes = styles.seat;
    if (seat.status === 'BOOKED') classes += ` ${styles.booked}`;
    if (seat.status === 'HOLD') classes += ` ${styles.hold}`;
    if (seat.status === 'AVAILABLE') classes += ` ${styles.available}`;
    if (isSeatSelected(seat.seatId)) classes += ` ${styles.selected}`;
    if (loadingSeatId === seat.seatId) classes += ` ${styles.loading}`;
    return classes;
  };

  // Show loading state while fetching seats
  if (initialLoading || !seats) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingOverlay} style={{ position: 'relative', minHeight: '400px' }}>
          <div className={styles.loadingContent}>
            <div className={styles.loadingSpinner}></div>
            <p>Loading seats...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* City Selection */}
      <div className={styles.citySelection}>
        <select
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className={styles.cityDropdown}
        >
          <option value="" disabled>Select City</option>
          <option value="Ahmedabad">Ahmedabad</option>
          <option value="Delhi">Delhi</option>
          <option value="Mumbai">Mumbai</option>
          <option value="Bangalore">Bangalore</option>
        </select>
      </div>

      {/* Event Header */}
      <div className={styles.eventHeader}>
        <h1>{eventData.eventName}</h1>
        <div className={styles.eventDetails}>
          <span>{eventData.venue}</span>
          <span className={styles.divider}>|</span>
          <span>{new Date(eventData.date).toLocaleDateString('en-IN', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })}</span>
          <span className={styles.divider}>|</span>
          <span>{eventData.time}</span>
        </div>
      </div>

      {/* Stage */}
      <div className={styles.stage}>
        <span>STAGE</span>
      </div>

      {/* Seat Layout */}
      <div className={styles.seatLayout}>
        {seats.sections.map((section) => (
          <div key={section.sectionId} className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionInfo}>
                <h3>{section.sectionName}</h3>
                <span className={styles.price}>
                  {eventData.currency}{section.price.toLocaleString()}
                </span>
              </div>
              <button
                className={styles.quickBook}
                onClick={() => handleSectionBook(section)}
                disabled={isLoading}
              >
                Quick Book
              </button>
            </div>

            <div className={styles.rows}>
              {section.rows.map((row, rowIndex) => (
                <div key={rowIndex} className={styles.row}>
                  <span className={styles.rowLabel}>R{rowIndex + 1}</span>
                  <div className={styles.seats}>
                    {row.map((seat) => (
                      <div
                        key={seat.seatId}
                        className={getSeatClass(seat)}
                        onClick={() => handleSeatClick(seat, section)}
                        title={`${seat.seatId} - ${seat.status}`}
                      >
                        {loadingSeatId === seat.seatId ? (
                          <div className={styles.spinner}></div>
                        ) : seat.status === 'HOLD' ? (
                          <span className={styles.lockIcon}>🔒</span>
                        ) : seat.status === 'BOOKED' ? (
                          <span className={styles.bookedIcon}>✕</span>
                        ) : (
                          <span className={styles.seatNumber}>
                            {seat.seatId}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className={styles.legend}>
        <div className={styles.legendItem}>
          <div className={`${styles.legendBox} ${styles.available}`}></div>
          <span>Available</span>
        </div>
        <div className={styles.legendItem}>
          <div className={`${styles.legendBox} ${styles.selected}`}></div>
          <span>Selected</span>
        </div>
        <div className={styles.legendItem}>
          <div className={`${styles.legendBox} ${styles.hold}`}></div>
          <span>On Hold</span>
        </div>
        <div className={styles.legendItem}>
          <div className={`${styles.legendBox} ${styles.booked}`}></div>
          <span>Booked</span>
        </div>
      </div>

      {/* Selection Bar - shown when seats are selected */}
      {selectedSeats.length > 0 && (
        <div className={styles.selectionBar}>
          <div className={styles.selectionInfo}>
            <span className={styles.selectionCount}>
              {selectedSeats.length} seat{selectedSeats.length > 1 ? 's' : ''} selected
            </span>
            <span className={styles.selectedSeats}>
              {selectedSeats.map(s => s.seat.seatId).join(', ')}
            </span>
            <span className={styles.selectionTotal}>
              Total: {eventData.currency}{(selectedSeats[0]?.section.price * selectedSeats.length).toLocaleString()}
            </span>
          </div>
          <div className={styles.selectionActions}>
            <button
              className={styles.clearButton}
              onClick={handleClearSelection}
              disabled={isLoading}
            >
              Clear
            </button>
            <button
              className={styles.confirmButton}
              onClick={handleConfirmBooking}
              disabled={isLoading}
            >
              {isLoading ? 'Booking...' : `Book ${selectedSeats.length} Seat${selectedSeats.length > 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}

      {/* Loading Overlay */}
      {isLoading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingContent}>
            <div className={styles.loadingSpinner}></div>
            <p>Reserving seats...</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default Booking;
