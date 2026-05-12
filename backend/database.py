import sqlite3


def get_connection():
    return sqlite3.connect("login.db")


def Create_table():
    mydb = get_connection()
    cur = mydb.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            password TEXT
        )
    """
    )
    mydb.commit()


def show_tables():
    mydb = get_connection()
    cur = mydb.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
    print(cur.fetchall())


def insert_table(values: tuple):
    mydb = get_connection()
    cur = mydb.cursor()
    cur.execute(
        "INSERT INTO users(email, password) VALUES (?, ?)",
        values,
    )
    mydb.commit()


def show_data():
    mydb = get_connection()
    cur = mydb.cursor()
    cur.execute("SELECT * FROM users")
    print(cur.fetchall())


# Create the table if this script is executed
if __name__ == "__main__":
    Create_table()
    print("Database and table 'users' created successfully!")
