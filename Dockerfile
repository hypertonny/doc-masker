FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for OCR and PDF rendering
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install the large spacy model FIRST to cache it independently 
# of other requirements. This prevents a 750MB download when requirements.txt changes.
RUN pip install --no-cache-dir spacy==3.8.13 https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl

# Copy requirements and install the rest of the dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Create persistent storage directories if they don't exist
RUN mkdir -p uploads outputs

# Expose the port Uvicorn will run on
EXPOSE 8000

# Start the application using Uvicorn
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
