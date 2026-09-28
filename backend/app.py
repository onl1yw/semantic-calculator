import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from threadpoolctl import threadpool_limits

from .config import Settings
from .limits import ApiGuard
from .store import DIMENSIONS, VectorStore, clean_word


class NearestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_revision: str = Field(min_length=1, max_length=128, strict=True)
    vector: list[Annotated[float, Field(strict=True, allow_inf_nan=False)]] = Field(
        min_length=DIMENSIONS, max_length=DIMENSIONS)
    exclude_words: list[Annotated[str, Field(strict=True, min_length=1, max_length=128)]] = Field(
        default_factory=list, max_length=128)


class SearchService:
    def __init__(self, store, settings):
        self.store, self.settings = store, settings
        self.pool = ThreadPoolExecutor(max_workers=settings.search_concurrency,
                                       thread_name_prefix="dictionary-search")
        self.active = 0

    async def nearest(self, vector, exclude_words=()):
        return await self.call("nearest", vector, exclude_words)

    async def call(self, method, *args):
        if self.active >= self.settings.search_concurrency:
            raise HTTPException(503, "Поиск занят. Попробуйте через секунду.",
                                headers={"Retry-After": "1"})
        self.active += 1
        future = asyncio.get_running_loop().run_in_executor(
            self.pool, getattr(self.store, method), *args)

        def finished(done):
            self.active -= 1
            if not done.cancelled():
                done.exception()

        # A timeout does not release capacity while the CPU job is still running.
        future.add_done_callback(finished)
        try:
            return await asyncio.wait_for(asyncio.shield(future), self.settings.search_timeout)
        except TimeoutError:
            raise HTTPException(503, "Поиск занял слишком много времени.",
                                headers={"Retry-After": "1"}) from None


def create_app(settings=None, store=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        if store is not None:
            app.state.store = store
        else:
            app.state.store = VectorStore(settings.data_dir, verify=settings.verify_dictionary)
        app.state.search = SearchService(app.state.store, settings)
        try:
            with threadpool_limits(limits=1, user_api="blas"):
                yield
        finally:
            app.state.search.pool.shutdown(wait=True, cancel_futures=True)
            app.state.store.close()

    app = FastAPI(title="Semantic Calculator", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(ApiGuard, settings=settings)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_, __):
        # Validation details can contain the submitted vector. Do not echo it.
        return JSONResponse({"detail": "Некорректный запрос: проверьте слово, ревизию и 300 чисел вектора."},
                            status_code=422)

    @app.get("/api/health")
    async def health():
        return {"status": "ok", **app.state.store.metadata}

    @app.get("/api/words")
    async def words(prefix: str = Query(min_length=2, max_length=64)):
        value = clean_word(prefix)
        if len(value) < 2 or any(char.isspace() for char in value):
            raise HTTPException(422, "Введите начало одного слова, минимум два символа.")
        return {"words": await app.state.search.call("suggest", value)}

    @app.get("/api/words/{word}/vector")
    async def word_vector(word: str):
        if not 1 <= len(word) <= 64 or any(char.isspace() for char in word):
            raise HTTPException(422, "Введите одно слово длиной до 64 символов.")
        result = await app.state.search.call("vector", clean_word(word))
        if result is None:
            raise HTTPException(404, "Такого слова нет в словаре. Выберите слово из подсказок.")
        return result

    @app.post("/api/nearest")
    async def nearest(request: NearestRequest):
        if request.model_revision != app.state.store.metadata["model_revision"]:
            raise HTTPException(409, "Модель обновилась. Перезагрузите страницу.")
        if not any(request.vector):
            raise HTTPException(422, "Нулевой вектор не имеет ближайшего слова.")
        result = await app.state.search.nearest(request.vector, request.exclude_words)
        if result is None:
            raise HTTPException(422, "После исключения исходных слов не осталось кандидатов.")
        return result

    if settings.frontend_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
    return app


app = create_app()
