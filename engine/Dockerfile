FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt "psycopg[binary]>=3.2,<3.3"
COPY nova_engine ./nova_engine
RUN useradd --create-home nova && chown -R nova /app
USER nova
EXPOSE 8787
# API:    docker run … image
# Worker: docker run … image python -m nova_engine.worker
CMD ["python", "-m", "uvicorn", "nova_engine.api.app:app", "--host", "0.0.0.0", "--port", "8787", "--workers", "2"]
