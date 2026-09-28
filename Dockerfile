FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
COPY assets/ /build/assets/
RUN npm run build

FROM python:3.14-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    SC_VERIFY_DICTIONARY=true
WORKDIR /app
COPY requirements.lock.txt ./
COPY LICENSE NOTICE ./
RUN pip install --no-cache-dir -r requirements.lock.txt \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
COPY backend/ ./backend/
COPY --from=frontend /build/frontend/dist ./frontend/dist/
# Only the immutable runtime snapshot; never archives, SQLite, or raw model weights.
COPY data/dictionary-word2vec-nouns/manifest.json \
     data/dictionary-word2vec-nouns/words.json \
     data/dictionary-word2vec-nouns/vectors.npy ./data/dictionary-word2vec-nouns/
USER 10001:10001
EXPOSE 8000
CMD ["python", "-m", "backend"]
