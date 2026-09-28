"""One small SDK pool with bounded requests and no automatic query retries."""
import ydb


class StoreUnavailable(RuntimeError):
    pass


class YdbConnection:
    def __init__(self, settings):
        self.timeout = settings.ydb_query_timeout
        self.driver = ydb.Driver(
            endpoint=settings.ydb_endpoint,
            database=settings.ydb_database,
            credentials=ydb.credentials_from_env_variables(),
        )
        try:
            self.driver.wait(timeout=5, fail_fast=True)
            self.pool = ydb.QuerySessionPool(
                self.driver, size=settings.search_concurrency, workers_threads_count=1,
            )
        except Exception:
            self.driver.stop()
            raise

    def execute(self, query, parameters=None, timeout=None):
        duration = timeout or self.timeout
        try:
            return self.pool.execute_with_retries(
                query, parameters or {},
                retry_settings=ydb.RetrySettings(max_retries=0, max_session_acquire_timeout=.2),
                settings=ydb.BaseRequestSettings().with_timeout(duration),
            )
        except ydb.Error as error:
            # SDK errors may include queries or endpoint details; API never echoes them.
            raise StoreUnavailable("Dictionary database unavailable") from error

    def close(self):
        self.pool.stop()
        self.driver.stop()


def utf8(value):
    return value, ydb.PrimitiveType.Utf8
