from fastapi import FastAPI, Depends, HTTPException, Body, Query
from sqlalchemy import text, func
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import smtplib

from app.db import Base, engine
from app.config import SMTP_FROM, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USERNAME, SMTP_USE_TLS
from app.dependencies import get_db
from app.models import (
    User, 
    Sensor, 
    Measurement, 
    Device, 
    Alert, 
    AlertEvent,
    AlertRule, 
    MeasurementType, 
    Role, 
    UserRole
    )

from app.schemas import (
    UserResponse, 
    MeasurementCreate, 
    MeasurementResponse,
    DeviceResponse,
    SensorResponse,
    MeasurementStatsResponse,
    MeasurementTypeCreate,
    MeasurementTypeUpdate,
    DeviceCreate,
    DeviceUpdate,
    SensorCreate,
    SensorUpdate,
    UserCreate,
    UserUpdate,
    LoginRequest,
    TokenResponse
)

from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from fastapi.security import HTTPAuthorizationCredentials
from fastapi import Request
from fastapi import Response

from app.auth import (
    verify_password, 
    create_access_token, 
    hash_password, 
    get_current_user, 
    is_admin
    )

from fastapi.staticfiles import StaticFiles


templates = Jinja2Templates(directory="app/templates")

app = FastAPI(title="Meteo Monitoring API", version="1.0.0")
app.mount("/static", StaticFiles(directory="app/static"), name="static")

@app.on_event("startup")
def create_tables():
    Base.metadata.create_all(bind=engine)

@app.get("/", response_class=HTMLResponse)
def read_root(request: Request):
    """Root route - redirects to dashboard if authenticated, otherwise to login."""
    token = request.cookies.get("token")
    
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]
    
    if token:
        try:
            class FakeCredentials:
                credentials = token
            
            user = get_current_user(
                credentials=FakeCredentials(),
                db=next(get_db())
            )
            if user:
                return RedirectResponse(url="/dashboard", status_code=302)
        except:
            pass
    
    return RedirectResponse(url="/login-page", status_code=302)

@app.get("/health/db")
def check_db():
    with engine.connect() as connection:
        result = connection.execute(text("SELECT 1"))
        value = result.scalar()
        return {"database": "ok", "result": value}

def serialize_user(user: User):
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "is_active": user.is_active,
        "created_at": user.created_at,
        "roles": [user_role.role.name for user_role in user.roles]
    }


def get_or_create_allowed_role(role_name: str, db: Session):
    normalized_role = role_name.strip().lower() if role_name else "user"
    if normalized_role not in {"user", "admin"}:
        raise HTTPException(status_code=400, detail="Role must be user or admin")

    role = db.query(Role).filter(Role.name == normalized_role).first()
    if not role:
        role = Role(name=normalized_role)
        db.add(role)
        db.flush()

    return role


@app.get("/users", response_model=list[UserResponse])
def get_users(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can view users")

    users = db.query(User).order_by(User.email).all()
    return [serialize_user(existing_user) for existing_user in users]


@app.post("/users", response_model=UserResponse)
def create_user(
    payload: UserCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can create users")

    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="User with this email already exists")

    role = get_or_create_allowed_role(payload.role, db)

    new_user = User(
        email=payload.email,
        password_hash=hash_password(payload.password),
        first_name=payload.first_name,
        last_name=payload.last_name,
        is_active=payload.is_active
    )
    db.add(new_user)
    db.flush()

    db.add(UserRole(user_id=new_user.id, role_id=role.id))
    db.commit()
    db.refresh(new_user)

    return serialize_user(new_user)


@app.put("/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: int,
    payload: UserUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can edit users")

    user_to_update = db.query(User).filter(User.id == user_id).first()
    if not user_to_update:
        raise HTTPException(status_code=404, detail="User not found")

    update_data = payload.model_dump(exclude_unset=True)

    if "email" in update_data and update_data["email"] != user_to_update.email:
        existing = db.query(User).filter(User.email == update_data["email"]).first()
        if existing:
            raise HTTPException(status_code=400, detail="User with this email already exists")
        user_to_update.email = update_data["email"]

    if "first_name" in update_data:
        user_to_update.first_name = update_data["first_name"]
    if "last_name" in update_data:
        user_to_update.last_name = update_data["last_name"]
    if "is_active" in update_data:
        user_to_update.is_active = update_data["is_active"]
    if update_data.get("password"):
        user_to_update.password_hash = hash_password(update_data["password"])

    if "role" in update_data:
        role = get_or_create_allowed_role(update_data["role"], db)
        db.query(UserRole).filter(UserRole.user_id == user_id).delete()
        db.add(UserRole(user_id=user_id, role_id=role.id))

    db.commit()
    db.refresh(user_to_update)

    return serialize_user(user_to_update)


@app.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can delete users")

    if user.id == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    user_to_delete = db.query(User).filter(User.id == user_id).first()
    if not user_to_delete:
        raise HTTPException(status_code=404, detail="User not found")

    db.query(Device).filter(Device.user_id == user_id).update({Device.user_id: None})
    db.query(UserRole).filter(UserRole.user_id == user_id).delete()
    db.delete(user_to_delete)
    db.commit()

    return {"message": "User deleted"}


def send_alert_email(recipient: str, subject: str, body: str):
    if not SMTP_HOST or not SMTP_FROM:
        print("Alert email skipped: SMTP_HOST/SMTP_FROM are not configured")
        return

    message = EmailMessage()
    message["From"] = SMTP_FROM
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as smtp:
            if SMTP_USE_TLS:
                smtp.starttls()
            if SMTP_USERNAME and SMTP_PASSWORD:
                smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(message)
    except Exception as exc:
        print(f"Alert email failed for {recipient}: {exc}")


def evaluate_alert_rules_for_measurement(
    db: Session,
    sensor_id: int,
    value: float,
    measurement: Measurement
):
    rules = (
        db.query(AlertRule)
        .filter(
            AlertRule.sensor_id == sensor_id,
            AlertRule.is_active == True
        )
        .all()
    )

    sensor = db.query(Sensor).filter(Sensor.id == sensor_id).first()
    device = db.query(Device).filter(Device.id == sensor.device_id).first() if sensor else None
    owner = db.query(User).filter(User.id == device.user_id).first() if device and device.user_id else None

    for rule in rules:
        triggered = False

        if rule.min_value is not None and value < rule.min_value:
            triggered = True

        if rule.max_value is not None and value > rule.max_value:
            triggered = True

        active_alert = (
            db.query(Alert)
            .filter(
                Alert.alert_rule_id == rule.id,
                Alert.status == "active"
            )
            .first()
        )

        if triggered:
            if not active_alert:
                alert = Alert(
                    alert_rule_id=rule.id,
                    measurement_id=measurement.id,
                    message=f"Threshold exceeded: {value}",
                    severity="high",
                    status="active"
                )
                db.add(alert)
                db.flush()
                db.add(AlertEvent(
                    alert_id=alert.id,
                    measurement_id=measurement.id
                ))

                if owner and owner.email:
                    sensor_name = sensor.name if sensor else f"Sensor #{sensor_id}"
                    device_name = device.name if device else "Unknown device"
                    subject = f"Meteo alert: {sensor_name}"
                    body = (
                        f"Hello {owner.first_name or owner.email},\n\n"
                        f"An alert was triggered for {sensor_name} on {device_name}.\n"
                        f"Current value: {value}\n"
                        f"Minimum threshold: {rule.min_value if rule.min_value is not None else 'not set'}\n"
                        f"Maximum threshold: {rule.max_value if rule.max_value is not None else 'not set'}\n"
                        f"Time: {measurement.ts}\n\n"
                        "This email was sent by the Meteo Monitoring system."
                    )
                    send_alert_email(owner.email, subject, body)

        else:
            if active_alert:
                active_alert.status = "resolved"
                active_alert.resolved_at = datetime.utcnow()


def resolve_active_alerts_for_rule(db: Session, rule_id: int) -> int:
    resolved_at = datetime.utcnow()
    active_alerts = (
        db.query(Alert)
        .filter(
            Alert.alert_rule_id == rule_id,
            Alert.status == "active"
        )
        .all()
    )

    for alert in active_alerts:
        alert.status = "resolved"
        alert.resolved_at = resolved_at

    return len(active_alerts)


def normalize_query_datetime(value: datetime | None) -> datetime | None:
    if value and value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


@app.post("/measurements", response_model=MeasurementResponse)
def create_measurement(payload: MeasurementCreate, db: Session = Depends(get_db)):
    sensor = db.query(Sensor).filter(Sensor.id == payload.sensor_id).first()
    if not sensor:
        raise HTTPException(status_code=404, detail="Sensor not found")

    measurement = Measurement(
        sensor_id=payload.sensor_id, 
        ts=payload.ts, 
        value=payload.value
    )
    db.add(measurement)
    db.commit()
    db.refresh(measurement)

    evaluate_alert_rules_for_measurement(
        db=db,
        sensor_id=payload.sensor_id,
        value=payload.value,
        measurement=measurement
    )
    db.commit()
    
    return measurement

@app.get("/measurements", response_model=list[MeasurementResponse])
def get_measurements(db: Session = Depends(get_db)):
    measurements = db.query(Measurement).all()
    return measurements

@app.get("/devices", response_model=list[DeviceResponse])
def get_devices(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if is_admin(user):
        devices = db.query(Device).all()
    else:
        devices = db.query(Device).filter(Device.user_id == user.id).all()
    return devices

@app.get("/sensors", response_model=list[SensorResponse])
def get_sensors(
    device_id: int = None,
    measurement_type_id: int = None,
    user: User = Depends(get_current_user),
    location: str = None,
    db: Session = Depends(get_db)
):

    if is_admin(user):
        devices = db.query(Device).all()
    else:
        devices = db.query(Device).filter(Device.user_id == user.id).all()
    
    allowed_device_ids = [d.id for d in devices]
    
    query = db.query(Sensor).filter(Sensor.device_id.in_(allowed_device_ids))
    if device_id:
        query = query.filter(Sensor.device_id == device_id)
    if measurement_type_id:
        query = query.filter(Sensor.measurement_type_id == measurement_type_id)
    sensors = query.all()
    return sensors

@app.get("/sensors/{sensor_id}", response_model=SensorResponse)
def get_sensor(sensor_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sensor = db.query(Sensor).filter(Sensor.id == sensor_id).first()
    if not sensor:
        raise HTTPException(status_code=404, detail="Sensor not found")
    return sensor


@app.get("/measurement-types", response_model=list[dict])
def get_measurement_types(db: Session = Depends(get_db)):
    """Get all measurement types."""
    types = db.query(MeasurementType).order_by(MeasurementType.name).all()
    return [{"id": t.id, "name": t.name, "unit": t.unit} for t in types]


@app.post("/measurement-types")
def create_measurement_type(
    payload: MeasurementTypeCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can create measurement types")
    
    existing = db.query(MeasurementType).filter(MeasurementType.name == payload.name).first()
    if existing:
        raise HTTPException(status_code=400, detail="Measurement type already exists")
    
    mt = MeasurementType(name=payload.name, unit=payload.unit)
    db.add(mt)
    db.commit()
    db.refresh(mt)
    return {"id": mt.id, "name": mt.name, "unit": mt.unit, "message": "Measurement type created"}


@app.put("/measurement-types/{type_id}")
def update_measurement_type(
    type_id: int,
    payload: MeasurementTypeUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can edit measurement types")

    mt = db.query(MeasurementType).filter(MeasurementType.id == type_id).first()
    if not mt:
        raise HTTPException(status_code=404, detail="Measurement type not found")

    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data and update_data["name"] != mt.name:
        existing = db.query(MeasurementType).filter(MeasurementType.name == update_data["name"]).first()
        if existing:
            raise HTTPException(status_code=400, detail="Measurement type already exists")
        mt.name = update_data["name"]

    if "unit" in update_data:
        mt.unit = update_data["unit"]

    db.commit()
    db.refresh(mt)
    return {"id": mt.id, "name": mt.name, "unit": mt.unit}


@app.delete("/measurement-types/{type_id}")
def delete_measurement_type(
    type_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can delete measurement types")

    mt = db.query(MeasurementType).filter(MeasurementType.id == type_id).first()
    if not mt:
        raise HTTPException(status_code=404, detail="Measurement type not found")

    sensor_count = db.query(Sensor).filter(Sensor.measurement_type_id == type_id).count()
    if sensor_count:
        raise HTTPException(status_code=400, detail="Cannot delete a measurement type used by sensors")

    db.delete(mt)
    db.commit()
    return {"message": "Measurement type deleted"}


@app.post("/devices")
def create_device(
    device: DeviceCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    print(f"Creating device: {device}")

    if not is_admin(user):
        pass

    new_device = Device(
        name=device.name,
        passkey=device.passkey,
        serial_number=device.serial_number,
        location_name=device.location_name,
        user_id=user.id,
        status="active"
    )

    db.add(new_device)
    db.commit()
    db.refresh(new_device)

    return {
        "id": new_device.id,
        "name": new_device.name,
        "message": "Device created"
    }


@app.delete("/devices/{device_id}")
def delete_device(
    device_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    if not is_admin(user) and device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this device")
    
    db.query(Sensor).filter(Sensor.device_id == device_id).delete()
    db.delete(device)
    db.commit()
    return {"message": "Device deleted"}


@app.put("/devices/{device_id}", response_model=DeviceResponse)
def update_device(
    device_id: int,
    payload: DeviceUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    if not is_admin(user) and device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to edit this device")

    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(device, field, value)

    db.commit()
    db.refresh(device)
    return device


@app.post("/sensors")
def create_sensor(
    sensor: SensorCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    print(f"Creating sensor: {sensor}")

    device = db.query(Device).filter(Device.id == sensor.device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    
    if not is_admin(user) and device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to add sensor to this device")
    
    mt = db.query(MeasurementType).filter(MeasurementType.id == sensor.measurement_type_id).first()
    if not mt:
        raise HTTPException(status_code=404, detail="Measurement type not found")
    
    new_sensor = Sensor(
        device_id=sensor.device_id,
        measurement_type_id=sensor.measurement_type_id,
        name=sensor.name,
        location=sensor.location
    )

    db.add(new_sensor)
    db.commit()
    db.refresh(new_sensor)

    return {"id": new_sensor.id, "name": new_sensor.name, "message": "Sensor created"}


@app.delete("/sensors/{sensor_id}")
def delete_sensor(
    sensor_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    sensor = db.query(Sensor).filter(Sensor.id == sensor_id).first()
    if not sensor:
        raise HTTPException(status_code=404, detail="Sensor not found")
    
    device = db.query(Device).filter(Device.id == sensor.device_id).first()
    
    if not is_admin(user) and device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this sensor")
    
    db.delete(sensor)
    db.commit()
    return {"message": "Sensor deleted"}


@app.put("/sensors/{sensor_id}", response_model=SensorResponse)
def update_sensor(
    sensor_id: int,
    payload: SensorUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    sensor = db.query(Sensor).filter(Sensor.id == sensor_id).first()
    if not sensor:
        raise HTTPException(status_code=404, detail="Sensor not found")

    current_device = db.query(Device).filter(Device.id == sensor.device_id).first()
    if not current_device:
        raise HTTPException(status_code=404, detail="Sensor device not found")

    if not is_admin(user) and current_device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to edit this sensor")

    update_data = payload.model_dump(exclude_unset=True)
    if "device_id" in update_data:
        new_device = db.query(Device).filter(Device.id == update_data["device_id"]).first()
        if not new_device:
            raise HTTPException(status_code=404, detail="Device not found")
        if not is_admin(user) and new_device.user_id != user.id:
            raise HTTPException(status_code=403, detail="Not authorized to move sensor to this device")

    if "measurement_type_id" in update_data:
        mt = db.query(MeasurementType).filter(MeasurementType.id == update_data["measurement_type_id"]).first()
        if not mt:
            raise HTTPException(status_code=404, detail="Measurement type not found")

    for field, value in update_data.items():
        setattr(sensor, field, value)

    db.commit()
    db.refresh(sensor)
    return sensor


@app.get("/measurement-types/{type_id}")
def get_measurement_type(type_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    mt = db.query(MeasurementType).filter(MeasurementType.id == type_id).first()
    if not mt:
        raise HTTPException(status_code=404, detail="Measurement type not found")
    return {"id": mt.id, "name": mt.name, "unit": mt.unit}

@app.get("/measurements/by-sensor/{sensor_id}", response_model=list[MeasurementResponse])
def get_measurements_by_sensor(
        sensor_id: int, 
        hours: int = 24,
        from_ts: datetime | None = Query(None),
        to_ts: datetime | None = Query(None),
        user: User = Depends(get_current_user),
        db: Session = Depends(get_db)
        ):
    sensor = db.query(Sensor).filter(Sensor.id == sensor_id).first()
    if not sensor:
        raise HTTPException(status_code=404, detail="Sensor not found")

    if (from_ts is None) != (to_ts is None):
        raise HTTPException(status_code=400, detail="Both from_ts and to_ts are required for a custom range")

    from_ts = normalize_query_datetime(from_ts)
    to_ts = normalize_query_datetime(to_ts)

    if from_ts and to_ts and from_ts > to_ts:
        raise HTTPException(status_code=400, detail="from_ts must be before to_ts")

    query = db.query(Measurement).filter(Measurement.sensor_id == sensor_id)

    if from_ts and to_ts:
        query = query.filter(Measurement.ts >= from_ts, Measurement.ts <= to_ts)
    else:
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        query = query.filter(Measurement.ts >= cutoff)

    measurements = (
        query
        .order_by(Measurement.ts.asc())
        .limit(500)
        .all()
    )
    return measurements

@app.get("/measurements/stats/{sensor_id}", response_model=MeasurementStatsResponse)
def get_measurement_stats(
        sensor_id: int,
        hours: int = 24,
        from_ts: datetime | None = Query(None),
        to_ts: datetime | None = Query(None),
        db: Session = Depends(get_db)
        ):
    sensor = db.query(Sensor).filter(Sensor.id == sensor_id).first()
    if not sensor:
        raise HTTPException(status_code=404, detail="Sensor not found")

    if (from_ts is None) != (to_ts is None):
        raise HTTPException(status_code=400, detail="Both from_ts and to_ts are required for a custom range")

    from_ts = normalize_query_datetime(from_ts)
    to_ts = normalize_query_datetime(to_ts)

    if from_ts and to_ts and from_ts > to_ts:
        raise HTTPException(status_code=400, detail="from_ts must be before to_ts")

    query = db.query(
        func.min(Measurement.value),
        func.max(Measurement.value),
        func.avg(Measurement.value),
    ).filter(Measurement.sensor_id == sensor_id)

    if from_ts and to_ts:
        query = query.filter(Measurement.ts >= from_ts, Measurement.ts <= to_ts)
    else:
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        query = query.filter(Measurement.ts >= cutoff)

    result = query.first()

    return MeasurementStatsResponse(
        sensor_id=sensor_id,
        min_value=float(result[0]) if result[0] is not None else None,
        max_value=float(result[1]) if result[1] is not None else None,
        avg_value=float(result[2]) if result[2] is not None else None,
    )


@app.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email).first()

    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token({"user_id": user.id})

    response = JSONResponse(content={"access_token": token, "token_type": "bearer"})
    response.set_cookie(key="token", value=token, httponly=True, samesite="lax")
    return response


@app.get("/login-page", response_class=HTMLResponse)
def login_page(request: Request):
    """Login page - serves the login form."""
    return templates.TemplateResponse("login.html", {
        "request": request
    })


@app.get("/me")
def get_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "roles": [r.role.name for r in user.roles]
    }


@app.get("/my-token")
def get_my_token(request: Request):
    """Get current user's token for API testing."""
    token = request.cookies.get("token")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"token": token}


@app.post("/logout")
def logout():
    """Logout - clears the auth cookie."""
    response = RedirectResponse(url="/login-page", status_code=302)
    response.delete_cookie(key="token")
    return response


@app.post("/alert-rules")
def create_rule(
    data: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    
    sensor_id = data.get("sensor_id")
    max_value = data.get("max_value")
    min_value = data.get("min_value")
    
    if not sensor_id:
        raise HTTPException(status_code=400, detail="sensor_id is required")
    
    sensor = db.query(Sensor).filter(Sensor.id == sensor_id).first()
    if not sensor:
        raise HTTPException(status_code=404, detail="Sensor not found")
    
    device = db.query(Device).filter(Device.id == sensor.device_id).first()
    if not is_admin(user) and device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to create alert for this sensor")
    
    rule = AlertRule(
        sensor_id=sensor_id,
        max_value=max_value,
        min_value=min_value,
        is_active=True
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    
    return {"id": rule.id, "message": "Alert rule created successfully"}


@app.put("/alert-rules/{rule_id}")
def update_alert_rule(
    rule_id: int,
    sensor_id: int = Body(None),
    min_value: float = Body(None),
    max_value: float = Body(None),
    is_active: bool = Body(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    
    sensor = db.query(Sensor).filter(Sensor.id == rule.sensor_id).first()
    device = db.query(Device).filter(Device.id == sensor.device_id).first()
    if not is_admin(user) and device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to modify this alert rule")
    
    if sensor_id is not None:
        rule.sensor_id = sensor_id
    if min_value is not None:
        rule.min_value = min_value
    if max_value is not None:
        rule.max_value = max_value
    if is_active is not None:
        rule.is_active = is_active
        if not is_active:
            resolve_active_alerts_for_rule(db, rule.id)
    
    db.commit()
    db.refresh(rule)
    
    return {"id": rule.id, "message": "Alert rule updated successfully"}


@app.delete("/alert-rules/{rule_id}")
def delete_alert_rule(
    rule_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    
    sensor = db.query(Sensor).filter(Sensor.id == rule.sensor_id).first()
    device = db.query(Device).filter(Device.id == sensor.device_id).first()
    if not is_admin(user) and device.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this alert rule")
    
    rule.is_active = False
    resolved_alerts_count = resolve_active_alerts_for_rule(db, rule.id)
    db.commit()

    return {
        "message": "Alert rule deactivated successfully",
        "resolved_alerts": resolved_alerts_count
    }


@app.get("/alert-rules")
def get_alert_rules(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):

    rules = db.query(AlertRule).filter(AlertRule.is_active == True).all()
    
    if not is_admin(user):
        user_devices = db.query(Device).filter(Device.user_id == user.id).all()
        user_device_ids = [d.id for d in user_devices]

        user_sensors = db.query(Sensor).filter(Sensor.device_id.in_(user_device_ids)).all()
        user_sensor_ids = [s.id for s in user_sensors]

        rules = [r for r in rules if r.sensor_id in user_sensor_ids]
    
    return [
        {
            "id": r.id,
            "sensor_id": r.sensor_id,
            "min_value": r.min_value,
            "max_value": r.max_value,
            "is_active": r.is_active,
            "created_at": r.created_at.isoformat() if r.created_at else None
        }
        for r in rules
    ]


@app.get("/alert-history")
def get_alert_history(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    alerts = db.query(Alert).order_by(Alert.created_at.desc()).all()
    history = []

    for alert in alerts:
        rule = db.query(AlertRule).filter(AlertRule.id == alert.alert_rule_id).first()
        if not rule:
            continue

        sensor = db.query(Sensor).filter(Sensor.id == rule.sensor_id).first()
        if not sensor:
            continue

        device = db.query(Device).filter(Device.id == sensor.device_id).first()
        if not device:
            continue

        if not is_admin(user) and device.user_id != user.id:
            continue

        owner = db.query(User).filter(User.id == device.user_id).first() if device.user_id else None
        measurement = db.query(Measurement).filter(Measurement.id == alert.measurement_id).first()

        history.append({
            "id": alert.id,
            "status": alert.status,
            "severity": alert.severity,
            "message": alert.message,
            "created_at": alert.created_at.isoformat() if alert.created_at else None,
            "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
            "sensor_id": sensor.id,
            "sensor_name": sensor.name,
            "device_id": device.id,
            "device_name": device.name,
            "user_id": owner.id if owner else None,
            "user_email": owner.email if owner else None,
            "min_value": rule.min_value,
            "max_value": rule.max_value,
            "measurement_value": float(measurement.value) if measurement else None,
            "measurement_ts": measurement.ts.isoformat() if measurement and measurement.ts else None
        })

    return history


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request):
    """Dashboard page - requires authentication via cookie or header."""
    token = request.cookies.get("token")

    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]
    
    if not token:
        return RedirectResponse(url="/login-page", status_code=302)
    
    db = next(get_db())
    
    try:        
        class FakeCredentials:
            credentials = token
        
        user = get_current_user(
            request=request,
            credentials=FakeCredentials(),
            db=db
        )
    except:
        return RedirectResponse(url="/login-page", status_code=302)
    
    if is_admin(user):
        devices = db.query(Device).filter(Device.status == "active").all()
    else:
        devices = db.query(Device).filter(
            Device.status == "active",
            Device.user_id == user.id
        ).all()
    
    measurement_types = db.query(MeasurementType).all()
    
    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "username": user.first_name,
        "is_admin": is_admin(user),
        "devices": [{"id": d.id, "name": d.name, "location": d.location_name} for d in devices],
        "measurement_types": [{"id": m.id, "name": m.name, "unit": m.unit} for m in measurement_types]
    })


def f_to_c(f):
    return (float(f) - 32) * 5.0 / 9.0


@app.post("/ingest/ecowitt")
async def ingest_ecowitt(request: Request, db: Session = Depends(get_db)):
    """
    Receive data from Ecowitt weather station.
    """
    form = await request.form()
    data = dict(form)

    passkey = data.get("PASSKEY")

    if not passkey:
        print("Missing PASSKEY in request")
        return {"status": "error", "detail": "Missing PASSKEY"}

    device = db.query(Device).filter(Device.passkey == passkey).first()

    if not device:
        print(f"Unknown device.")
        return {"status": "error", "detail": "Unknown device"}

    device_id = device.id

    if not device_id:
        print("device_id query parameter is required")
        return {"status": "error", "detail": "device_id query parameter is required"}
    
    try:
        device_id = int(device_id)
    except ValueError:
        print("device_id must be an integer")
        return {"status": "error", "detail": "device_id must be an integer"}

    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        print(f"Device {device_id} not found in database")
        return {"status": "error", "detail": f"Device {device_id} not found"}

    measurement_types = db.query(MeasurementType).all()
    meas_type_by_name = {mt.name: mt.id for mt in measurement_types}
    
    sensors = db.query(Sensor).filter(Sensor.device_id == device_id).all()
    sensors_by_type = {(s.measurement_type_id, s.location): s.id for s in sensors}

    ecowitt_field_map = {
        "temp1f": ("temperature", f_to_c, "outdoor"),
        "tempinf": ("temperature", f_to_c, "indoor"),
        "humidity1": ("humidity", None, "outdoor"),
        "humidityin": ("humidity", None, "indoor"),
        "baromrelin": ("pressure", None, "indoor"),
        "baromabsin": ("pressure", None, "outdoor"),
        "wind_speed": ("wind_speed", None, "outdoor"),
    }

    try:
        ts = datetime.strptime(data.get("dateutc"), "%Y-%m-%d %H:%M:%S")

        for ecowitt_field, (meas_type_name, converter, location) in ecowitt_field_map.items():
            if ecowitt_field not in data:
                print(f"Field {ecowitt_field} not in data, skipping")
                continue
                
            value = data.get(ecowitt_field)
            if not value:
                print(f"Field {ecowitt_field} has no value, skipping")
                continue
            
            meas_type_id = meas_type_by_name.get(meas_type_name)
            if not meas_type_id:
                print(f"Unknown measurement type: {meas_type_name}")
                continue
            
            sensor_id = sensors_by_type.get((meas_type_id, location))
            if not sensor_id:
                print(f"No sensor for device {device_id}, measurement type {meas_type_name}")
                continue
            
            try:
                if converter:
                    converted_value = converter(value)
                else:
                    converted_value = float(value)
                    
                measurement = Measurement(
                    sensor_id=sensor_id,
                    ts=ts,
                    value=converted_value
                )
                db.add(measurement)
                db.flush()
                evaluate_alert_rules_for_measurement(
                    db=db,
                    sensor_id=sensor_id,
                    value=converted_value,
                    measurement=measurement
                )
            except (ValueError, TypeError) as ve:
                print(f"Skipping {ecowitt_field}: invalid value {value} - {ve}")

        db.commit()
        return {"status": "ok", "message": "Data ingested successfully"}

    except Exception as e:
        print("Error:", e)
        db.rollback()
        return {"status": "error", "detail": str(e)}
