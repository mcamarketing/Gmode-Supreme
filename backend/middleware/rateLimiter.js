import rateLimit from 'express-rate-limit';

// Create different rate limiters for different endpoints
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

export const executionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 execution requests per minute
  message: 'Too many execution requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

export const opportunityLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 opportunity requests per minute
  message: 'Too many opportunity requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply different limiters to different routes
export default (req, res, next) => {
  if (req.path === '/api/execute') {
    executionLimiter(req, res, next);
  } else if (req.path === '/api/opportunities') {
    opportunityLimiter(req, res, next);
  } else {
    generalLimiter(req, res, next);
  }
};