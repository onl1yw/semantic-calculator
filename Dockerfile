FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    SC_VERIFY_DICTIONARY=true
WORKDIR /app
COPY requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
COPY backend/ ./backend/
COPY --from=frontend /build/dist ./frontend/dist/
# Only the immutable runtime snapshot; never archives, SQLite, or raw model weights.
COPY data/dictionary-word2vec-nouns/manifest.json \
     data/dictionary-word2vec-nouns/words.json \
     data/dictionary-word2vec-nouns/vectors.npy ./data/dictionary-word2vec-nouns/
USER 10001:10001
EXPOSE 8000
CMD ["python", "-m", "backend"]
