import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 200,                     // virtual users
  duration: '10s',              // test duration
  rps: 1000,                     // cap at 500 req/sec
};

export default function () {
  const url = 'https://hack-the-winter-r3-tzek.vercel.app/api/book-seat';
  const payload = JSON.stringify({
    seatId: "A1",
    sectionId: "A",
    city: "Mumbai",
    userId: `user_${Math.random()}` // simulate diff users
  });

  const params = {
    headers: {
      'Content-Type': 'application/json'
    },
  };

  const res = http.post(url, payload, params);

  check(res, {
    'status is 200/409': (r) => r.status === 200 || r.status === 409,
  });

  // no sleep → maximize throughput
}
