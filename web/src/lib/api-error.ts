

// Custom error class used for API-related errors.
// Extends the built-in Error to include an HTTP status code.
export class ApiError extends Error {
  // HTTP status code associated with the error (e.g., 404, 500).
  status: number;

  /**
   * Create a new ApiError
   * @param status - HTTP status code
   * @param message - Human-readable error message
   */
  constructor(status: number, message: string) {
    // Initialize base Error with the provided message
    super(message);

    // Set a specific name for easier identification in error handling
    this.name = "ApiError";
    // Attach the HTTP status code
    this.status = status;

    // Restore the prototype chain for instanceof checks to work correctly
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
