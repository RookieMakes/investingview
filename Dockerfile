FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (for Docker layer caching)
COPY backend/requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create data directory for SQLite
RUN mkdir -p /data

# Expose port
EXPOSE 9000

# Set environment variables
ENV PYTHONPATH=/app/backend
ENV DATABASE_PATH=/data/investingview.db
ENV TZ=America/New_York

# Run the application
CMD ["python", "backend/app.py"]
