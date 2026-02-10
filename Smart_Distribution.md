# 🧠 Thuật toán Hybrid Strategy - Smart Distribution

## 📊 Tổng quan

**Hybrid Strategy** là thuật toán thông minh kết hợp nhiều chỉ số để chọn account tốt nhất cho mỗi request. Nó cân bằng giữa:
- ✅ **Health** (sức khỏe account)
- ⏱️ **Rate Limiting** (giới hạn tốc độ)
- 📈 **Quota** (hạn mức sử dụng)
- 🔄 **LRU** (Least Recently Used - tính mới)

---

## 🎯 Công thức tính điểm

```
Score = (Health × W₁) + (TokenRatio × 100 × W₂) + (Quota × W₃) + (LRU × W₄)
```

**Trọng số mặc định:**
- `W₁ (health)` = **2** - Ưu tiên account khỏe mạnh
- `W₂ (tokens)` = **5** - Ưu tiên account còn nhiều token (quan trọng nhất)
- `W₃ (quota)` = **3** - Ưu tiên account còn quota
- `W₄ (lru)` = **0.1** - Nhẹ nhàng ưu tiên account ít dùng gần đây

---

## 🔍 Quy trình chọn Account (4 bước)

### **Bước 1: Lọc ứng viên (Candidates)**

Hệ thống lọc qua **4 cấp độ** (fallback levels) từ nghiêm ngặt → nới lỏng:

#### **Level 0: STRICT** (Ưu tiên cao nhất)
Chỉ chọn account thỏa mãn TẤT CẢ điều kiện:
- ✅ Không bị rate limit (cho model cụ thể)
- ✅ Không invalid/disabled
- ✅ Health score ≥ 50 (minUsable)
- ✅ Có tokens trong bucket (≥ 1 token)
- ✅ Quota > 5% (không critical)

#### **Level 1: IGNORE_HEALTH** (Bỏ qua health)
Nếu Level 0 không có ai:
- ⚠️ Cho phép account có health thấp (< 50)
- ✅ Vẫn yêu cầu: tokens, quota OK, không rate limit

#### **Level 2: IGNORE_TOKENS** (Bỏ qua tokens)
Nếu Level 1 không có ai:
- ⚠️ Cho phép account hết tokens
- ✅ Vẫn yêu cầu: health OK, quota OK, không rate limit

#### **Level 3: LAST_RESORT** (Phương án cuối)
Nếu Level 2 vẫn không có ai:
- ⚠️ Chỉ yêu cầu: không rate limit, không invalid/disabled
- ⚠️ Cho phép health thấp, hết tokens, quota thấp

---

### **Bước 2: Tính điểm cho từng ứng viên**

Mỗi account được tính điểm dựa trên 4 thành phần:

#### **1. Health Score (0-100)**
Theo dõi độ tin cậy của account:
- **Khởi tạo**: 70 điểm
- **Thành công**: +1 điểm/request
- **Rate limit**: -10 điểm
- **Lỗi khác**: -20 điểm
- **Hồi phục tự động**: +10 điểm/giờ
- **Giới hạn**: 0-100 điểm
- **Ngưỡng sử dụng**: ≥ 50 điểm

**Ví dụ:**
```
Account A: 80 điểm (khỏe mạnh) → đóng góp 80 × 2 = 160 vào score
Account B: 40 điểm (không khỏe) → bị loại (< 50)
```

#### **2. Token Bucket (0-1 ratio)**
Rate limiting phía client để tránh spam:
- **Bucket max**: 50 tokens
- **Tái tạo**: 6 tokens/phút
- **Khởi tạo**: 50 tokens
- **Tiêu thụ**: 1 token/request

**Công thức tái tạo:**
```javascript
CurrentTokens = min(MaxTokens, LastTokens + (minutesElapsed × tokensPerMinute))
```

**Ví dụ:**
```
Account A: 40/50 tokens → ratio = 0.8 → đóng góp 0.8 × 100 × 5 = 400
Account B: 5/50 tokens  → ratio = 0.1 → đóng góp 0.1 × 100 × 5 = 50
```

#### **3. Quota Fraction (0-100)**
Phần trăm hạn mức còn lại:
- **100%**: Chưa dùng
- **10%**: Mức thấp (low) → giảm điểm
- **≤5%**: Mức nguy hiểm (critical) → bị loại

**Ví dụ:**
```
Account A: 80% quota → đóng góp 80 × 3 = 240
Account B: 3% quota  → bị loại (< 5%)
```

#### **4. LRU Score (0-100)**
Dựa trên thời gian từ lần dùng cuối:
```javascript
LRU = min(100, secondsSinceLastUse / 60)
```
- **Mới dùng** (0s): 0 điểm
- **1 phút trước**: 1 điểm
- **100 phút trước**: 100 điểm (max)

**Ví dụ:**
```
Account A: 30 phút → LRU = 30 → đóng góp 30 × 0.1 = 3
Account B: 5 phút  → LRU = 5  → đóng góp 5 × 0.1 = 0.5
```

---

### **Bước 3: Sắp xếp và chọn**

```javascript
// Sắp xếp theo điểm giảm dần
scored.sort((a, b) => b.score - a.score);

// Chọn account có điểm cao nhất
const best = scored[0];
```

**Ví dụ tính điểm:**
```
Account A:
  Health: 80 × 2     = 160
  Tokens: 0.8 × 500  = 400
  Quota:  80 × 3     = 240
  LRU:    30 × 0.1   = 3
  ────────────────────────
  TOTAL              = 803 ✅ Winner!

Account B:
  Health: 70 × 2     = 140
  Tokens: 0.3 × 500  = 150
  Quota:  90 × 3     = 270
  LRU:    5 × 0.1    = 0.5
  ────────────────────────
  TOTAL              = 560.5
```

---

### **Bước 4: Cập nhật trạng thái**

Sau khi chọn account:
1. **Consume token**: Trừ 1 token từ bucket
2. **Update lastUsed**: Đánh dấu thời gian sử dụng
3. **Return**: Trả về account và index

Sau khi request hoàn thành:
- **Thành công** → `recordSuccess()`: +1 health
- **Rate limit** → `recordRateLimit()`: -10 health
- **Lỗi khác** → `recordFailure()`: -20 health
- **Token refund**: Hoàn lại token nếu request fail sớm

---

## 🎭 Ví dụ thực tế

**Tình huống:** 3 accounts, cần chọn cho model `claude-sonnet-4-5-thinking`

```
Account 1:
  email: user1@gmail.com
  health: 85 (khỏe)
  tokens: 45/50 (0.9 ratio)
  quota: 75% (còn nhiều)
  lastUsed: 2 phút trước

  → Score = (85×2) + (0.9×500) + (75×3) + (2×0.1)
         = 170 + 450 + 225 + 0.2
         = 845.2 ✅

Account 2:
  email: user2@gmail.com
  health: 90 (rất khỏe)
  tokens: 10/50 (0.2 ratio) ⚠️
  quota: 95% (gần như full)
  lastUsed: 10 phút trước

  → Score = (90×2) + (0.2×500) + (95×3) + (10×0.1)
         = 180 + 100 + 285 + 1
         = 566

Account 3:
  email: user3@gmail.com
  health: 40 (yếu) ❌
  tokens: 50/50 (full)
  quota: 100%
  lastUsed: 60 phút trước

  → BỊ LOẠI (health < 50)
```

**Kết quả:** Chọn **Account 1** vì có điểm cao nhất (845.2)

---

## 🔄 Hồi phục tự động

### Token Bucket Regeneration
```javascript
Tokens = min(MaxTokens, CurrentTokens + (minutesElapsed × 6))
```
**Ví dụ:** Account có 20 tokens, sau 5 phút:
```
NewTokens = min(50, 20 + (5 × 6)) = min(50, 50) = 50
```

### Health Score Recovery
```javascript
Health = min(100, CurrentHealth + (hoursElapsed × 10))
```
**Ví dụ:** Account có 40 health, sau 3 giờ:
```
NewHealth = min(100, 40 + (3 × 10)) = 70 (có thể dùng lại!)
```

---

## 📈 Ưu điểm

1. **Cân bằng tải** - Token bucket ngăn spam vào 1 account
2. **Fault tolerance** - Health tracking tránh account lỗi liên tục
3. **Quota-aware** - Tránh accounts gần hết hạn mức
4. **Fairness** - LRU đảm bảo phân phối đều
5. **Adaptive** - Fallback levels đảm bảo luôn có account
6. **Self-healing** - Tự động hồi phục health và tokens theo thời gian

---

## ⚠️ Khi nào KHÔNG có account?

Hệ thống chẩn đoán và báo lỗi khi không tìm được account phù hợp:

```
Reason: 2 unusable/disabled, 3 no tokens, 1 critical quota
WaitMs: 8000 (chờ 8s để tokens refill)
```

Hệ thống sẽ:
- Tính thời gian chờ ngắn nhất để có token
- Trả về lỗi với `waitMs` để client retry

**Các lý do phổ biến:**
- `unusable/disabled` - Accounts bị vô hiệu hóa hoặc invalid
- `unhealthy` - Health score quá thấp
- `no tokens` - Token bucket trống
- `critical quota` - Quota ≤ 5%

---

## 🔧 Cấu hình

Các tham số có thể tùy chỉnh trong config:

### Health Tracker
```javascript
{
  initial: 70,           // Điểm khởi tạo
  successReward: 1,      // Thưởng khi thành công
  rateLimitPenalty: -10, // Phạt khi rate limit
  failurePenalty: -20,   // Phạt khi lỗi
  recoveryPerHour: 10,   // Hồi phục/giờ
  minUsable: 50,         // Ngưỡng sử dụng
  maxScore: 100          // Điểm tối đa
}
```

### Token Bucket
```javascript
{
  maxTokens: 50,        // Dung lượng bucket
  tokensPerMinute: 6,   // Tốc độ tái tạo
  initialTokens: 50     // Token khởi tạo
}
```

### Quota Tracker
```javascript
{
  lowThreshold: 0.10,       // 10% - mức thấp
  criticalThreshold: 0.05,  // 5% - mức nguy hiểm
  staleMs: 300000,          // 5 phút - độ tươi dữ liệu
  unknownScore: 50          // Điểm cho quota không rõ
}
```

### Scoring Weights
```javascript
{
  health: 2,    // Trọng số health
  tokens: 5,    // Trọng số tokens (cao nhất)
  quota: 3,     // Trọng số quota
  lru: 0.1      // Trọng số LRU (thấp nhất)
}
```

---

## 📝 Code Implementation

File chính: `src/account-manager/strategies/hybrid-strategy.js`

**Trackers:**
- `src/account-manager/strategies/trackers/health-tracker.js`
- `src/account-manager/strategies/trackers/token-bucket-tracker.js`
- `src/account-manager/strategies/trackers/quota-tracker.js`

**Sử dụng:**
```bash
# Khởi động với Hybrid Strategy (mặc định)
npm start

# Hoặc chỉ định rõ
npm start -- --strategy=hybrid
```

---

## 🆚 So sánh với các strategies khác

| Tiêu chí | **Hybrid** | Sticky | Round-Robin |
|----------|-----------|--------|-------------|
| **Cân bằng tải** | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Cache optimization** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐ |
| **Fault tolerance** | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| **Quota awareness** | ⭐⭐⭐⭐⭐ | ⭐ | ⭐ |
| **Adaptive** | ⭐⭐⭐⭐⭐ | ⭐ | ⭐ |
| **Complexity** | Cao | Thấp | Thấp |

**Kết luận:** Hybrid Strategy là lựa chọn tốt nhất cho production với nhiều accounts và cần độ tin cậy cao! 🚀
