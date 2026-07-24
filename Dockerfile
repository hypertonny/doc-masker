FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for OCR and PDF rendering
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first to leverage Docker cache
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Download the spaCy NLP model required by Presidio
RUN python -m spacy download en_core_web_lg

# Copy the rest of the application
COPY . .

# Create persistent storage directories if they don't exist
RUN mkdir -p uploads outputs

# Expose the port Uvicorn will run on
EXPOSE 8000

# Start the application using Uvicorn
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
