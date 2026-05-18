/**
 * Mock in-memory database.
 * Replace with MongoDB / PostgreSQL by swapping databaseService.js — this
 * file and its shape are the only thing that changes.
 */

const tours = [
  {
    id: '1',
    destination: 'paris',
    name: 'Paris City Break',
    available: true,
    price: 1299,
    currency: 'USD',
    duration: '5 days',
    nextDates: ['2026-05-15', '2026-05-22', '2026-06-01'],
    description: 'Explore the City of Light with guided tours of the Eiffel Tower, Louvre, and more.',
  },
  {
    id: '2',
    destination: 'dubai',
    name: 'Dubai Luxury Escape',
    available: true,
    price: 2499,
    currency: 'USD',
    duration: '7 days',
    nextDates: ['2026-05-10', '2026-05-20', '2026-06-05'],
    description: 'Experience the best of Dubai: desert safaris, Burj Khalifa, and luxury shopping.',
  },
  {
    id: '3',
    destination: 'bali',
    name: 'Bali Paradise Retreat',
    available: true,
    price: 1899,
    currency: 'USD',
    duration: '8 days',
    nextDates: ['2026-05-18', '2026-06-01', '2026-06-15'],
    description: 'Tropical retreat with temple visits, rice terraces, and spa experiences.',
  },
  {
    id: '4',
    destination: 'new york',
    name: 'New York City Explorer',
    available: false,
    price: 1599,
    currency: 'USD',
    duration: '6 days',
    nextDates: [],
    description: 'Times Square, Central Park, Statue of Liberty — the city that never sleeps.',
  },
  {
    id: '5',
    destination: 'tokyo',
    name: 'Tokyo Cultural Journey',
    available: true,
    price: 3199,
    currency: 'USD',
    duration: '10 days',
    nextDates: ['2026-06-10', '2026-07-01', '2026-07-15'],
    description: 'Blend of ancient temples and futuristic technology in the heart of Japan.',
  },
];

const agents = [
  {
    id: 'agent1',
    name: 'Sarah Johnson',
    phone: '+15551234567',
    department: 'sales',
    available: true,
    email: 'sarah@cultureholidays.com',
  },
  {
    id: 'agent2',
    name: 'Michael Chen',
    phone: '+15559876543',
    department: 'support',
    available: true,
    email: 'michael@cultureholidays.com',
  },
  {
    id: 'agent3',
    name: 'Emily Rodriguez',
    phone: '+15551112222',
    department: 'sales',
    available: false,
    email: 'emily@cultureholidays.com',
  },
];

const leads = [];
const callLogs = [];

module.exports = { tours, agents, leads, callLogs };
