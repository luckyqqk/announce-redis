/**
 * ### 公告系统(公告性邮件)
 * 可用于发布通知,发放全服奖励等功能.
 * 与用户私人邮件不同,公告均为全服唯一,所有玩家共享.
 * 用户私人邮件,我会存在MySql,而公告,我会选择存redis.
 * 该公告系统仅提供公告数据的新增,获取和隐藏(没有开启,因为开启不等于新增,开启不应该给已读的用户再次发送红点,却需要给未读的用户发送红点,做此功能,得不偿失).
 * 公告的数量也不能超过31个,默认30个(没错,是一个int可支持的范围,用来做公告,也绰绰有余了).
 * 至于某个玩家对公告的可读/删除状态,应由逻辑方维护,存于该玩家的自身数据中.
 * 除此之外,逻辑方还需在用户数据中存储公告系统的版本,若版本不同,则可读/删除等状态需重置.
 * 逻辑方可获取全部公告,包括隐藏公告,在提供给用户时,需去除隐藏的公告.
 *
 * 数据来源:GM手动增加公告.
 * 设置隐藏:GM可手动将公告隐藏,隐藏后的公告,玩家不可见(由逻辑方保证).
 * 全部删除:GM可删除所有公告,数据直接销毁.注:若要删除某一条公告,请选择使用隐藏功能.
 * 数据销毁和版本变更:
 *       1.GM设置公告隐藏,当全部公告均为隐藏,则数据一并销毁,当前版本变更.(所以,隐藏操作应予以操作者提示)
 *       2.全部删除或手动变更版本,数据销毁,版本变更.
 *       3.自动销毁,每个版本当时间到达expireSeconds后,版本自动变更.
 */

var util = require('util');
var uuidV1 = require('uuid/v1');

var STATUS_SHOW         = 0;                    // 状态显示
var STATUS_HIDE         = 1;                    // 状态隐藏
var MAX_COUNT           = 30;                   // 同一版本最大容量
var EXPIRE_SECONDS      = 604800;               // (同一版本)公告过期时间,(默认一周)
var ANNOUNCE_PREFIX     = "ANNOUNCE:";          // 公告key的前缀
var VERSION_AND_EXPIRE  = "V:AND:E";            // 当前公告版本和过期时间
// error notice
var ERROR_INDEX_TYPE    = `idx must be number`;
var ERROR_INDEX_LOW     = `idx can not lower than 0`;
var ERROR_INDEX_HIGH    = `announce num can not higher then ${MAX_COUNT}`;
var ERROR_NO_DATA       = `can not find announce at idx : %d`;

/**
 * 公告系统
 *      公告存于redis的list结构,key为ANNOUNCE_PREFIX+日/月/年,该list为一个公告版本.
 *      当前版本和版本过期时间,以string的方式,用','分隔,存于redis,key为VERSION_AND_EXPIRE
 * @param redisClient
 * @param opts
 * @constructor
 */
var Announcement = function(redisClient, opts) {
    this.redis = redisClient;
    this.opts = opts || {};
    this.maxCount = this.opts.maxCount || MAX_COUNT;
    this.expireSeconds = this.opts.expireSeconds || EXPIRE_SECONDS;
    this.expireTime = 0;    // 过期时间戳,精确到秒,仅用于提示给GM当前版本还有多久过期.
    this.timerId = 0;       // timerOutId
};

module.exports = Announcement;

Announcement.prototype.start = function (cb) {
    var self = this;
    self.redis.get(VERSION_AND_EXPIRE, (err, vAndE)=> {
        if (!!err || !vAndE) {
            cb();
            return;
        }
        var expire = _getExpireTimeByVAndE(vAndE);
        self.timerId = setTimeout(_changeNewVersion, expire, self);
        cb();
    });
};

Announcement.prototype.stop = function(cb) {
    this.redis = null;
    if (!!this.timerId) {
        clearTimeout(this.timerId);
    }
    cb();
};

/**
 * 添加公告
 * @param {string} title
 * @param {string} content
 * @param {object} [attachObj]    附件,该对象必须支持转成string
 * @param cb
 */
Announcement.prototype.addAnnouncement = function(title, content, attachObj, cb) {
    var announce = {};
    announce.id = uuidV1();
    announce.title = title;
    announce.content = content;
    announce.attach = attachObj;
    announce.isHide = STATUS_SHOW;
    var self = this;
    self.redis.get(VERSION_AND_EXPIRE, (err, vAndE)=>{
        if (!!err) {
            cb(err);
            return;
        }
        var versionKey = !!vAndE ? _getVersionKeyByVAndE(vAndE) : null;
        var _pushRedis = function(announceKey, _cb) {
            self.redis.rpush(announceKey, JSON.stringify(announce), _cb);
        };
        if (!versionKey) {
            _changeNewVersion(self, (err, versionKey)=>{
                _pushRedis(versionKey, cb);
            });
        } else {
            self.redis.llen(versionKey, (err, count)=>{
                count == MAX_COUNT ? cb(ERROR_INDEX_HIGH) : _pushRedis(versionKey, cb);
            });
        }
    });
};

/**
 * 获得当前版本所有公告
 * @param cb
 * @returns {obj, Array, string, number} err, announceArray, version, expireTime
 */
Announcement.prototype.getAnnouncement = function(cb) {
    var self = this;
    self.redis.get(VERSION_AND_EXPIRE, (err, vAndE)=>{
        if (!!err) {
            cb(err);
        } else if (!vAndE) {
            var date = new Date();
            cb(null, [], null, 0);
        } else {
            var vAndEArr = vAndE.split(',');
            var versionKey = vAndEArr[0];
            var expire = vAndEArr[1];
            self.redis.lrange(versionKey, 0, -1, (_, data)=>{
                var allAnnounce = [];
                if (Array.isArray(data)) {
                    data.forEach(d=>{
                        allAnnounce.push(JSON.parse(d));
                    });
                }
                cb(null, allAnnounce, _getClientVersion(versionKey), expire);
            });
        }
    });
};

/**
 * 隐藏邮件(设置隐藏状态)
 * @param idx
 * @param cb
 */
Announcement.prototype.hideAnnouncement = function(idx, cb) {
    idx = +idx.toString();
    if (isNaN(idx)) {
        cb(ERROR_INDEX_TYPE);
        return;
    } else if (idx < 0) {
        cb(ERROR_INDEX_LOW);
        return;
    }
    var self = this;
    self.redis.get(VERSION_AND_EXPIRE, (err, vAndE)=>{
        if (!!err || !vAndE) {
            cb(err);
            return;
        }
        var versionKey = _getVersionKeyByVAndE(vAndE);
        self.redis.lrange(versionKey, 0, -1, (err, announces)=>{
            if (!!err || !announces) {
                cb(err);
                return;
            }
            if (idx > announces.length - 1) {
                cb(util.format(ERROR_NO_DATA, idx));
                return;
            }
            var aData = null, aimAnnounce = null, alreadyHide;
            var hideCount = 0;
            announces.forEach((d, index)=>{
                aData = JSON.parse(d);
                if (index == idx) {
                    alreadyHide = aData.isHide == STATUS_HIDE;
                    aimAnnounce = aData;
                    aimAnnounce.isHide = STATUS_HIDE;
                    hideCount++;
                } else
                    hideCount = aData.isHide == STATUS_HIDE ? hideCount + 1 : hideCount;
            });
            if (alreadyHide)
                cb();
            else if (hideCount == announces.length) // 全隐藏了就升级版本
                _changeNewVersion(self, cb);
            else
                self.redis.lset(versionKey, idx, JSON.stringify(aimAnnounce), cb);
        });
    });
};

/**
 * 获得当前版本号
 * @param cb
 */
Announcement.prototype.getVersion = function(cb) {
    this.redis.get(VERSION_AND_EXPIRE, (err, vAndE)=>{
        if (!!err)
            cb(err);
        else if (!vAndE)
            cb();
        else
            cb(err, _getClientVersion(_getVersionKeyByVAndE(vAndE)));
    });
};

/**
 * 获得当前版本过期时间
 * @returns {number}
 */
Announcement.prototype.getExpireTime = function(cb) {
    this.redis.get(VERSION_AND_EXPIRE, (err, vAndE)=>{
        if (!!err)
            cb(err);
        else if (!vAndE)
            cb(null, 0);
        else
            cb(err, _getExpireTimeByVAndE(vAndE));
    });
};

/**
 * 删除所有公告/升级版本
 * @param cb
 */
Announcement.prototype.deleteAll =
Announcement.prototype.changeVersion = function(cb) {
    _changeNewVersion(this, cb);
};

/**
 * 变更版本
 * @param {object}      self
 * @param {function}    [cb]
 * @private
 */
function _changeNewVersion(self, cb) {
    self.redis.get(VERSION_AND_EXPIRE, (err, oldVersion)=>{
        if (!!err) {
            if (!!cb) cb(err);
            return;
        }
        var funcArr = [], date = new Date(), dataSign = date.toLocaleDateString(), countSign = 1;
        var expire = self.expireSeconds + Math.floor(date.getTime() / 1000);  // 秒
        if (!!oldVersion) {
            var oldKey = _getVersionKeyByVAndE(oldVersion);
            funcArr.push(['del', oldKey]);
            if (dataSign == oldKey.split(':')[1].split('_')[0])
                countSign = ++oldKey.split('_')[1];
        }
        var versionKey = util.format(`%s%s_%d,%d`, ANNOUNCE_PREFIX, dataSign, countSign, expire);
        funcArr.push(['set', VERSION_AND_EXPIRE, versionKey]);
        self.redis.multi(funcArr).exec((err)=>{
            if (!!cb)
                cb(err, versionKey);
            if (!!err)
                return;
            if (!!self.timerId) clearTimeout(self.timerId);
            self.timerId = setTimeout(_changeNewVersion, expire, self);
        });
    });
}

/**
 * 给客户端的key,要去掉前缀
 * @param serverVersion
 * @returns {string}
 * @private
 */
function _getClientVersion(serverVersion) {
    return !!serverVersion ? serverVersion.split(':')[1] : null;
}

/**
 * 根据版本和过期时间,拆出版本key
 * @param vAndE
 * @returns {string}
 * @private
 */
function _getVersionKeyByVAndE(vAndE) {
    return vAndE.split(',')[0];
}

/**
 * 根据版本和过期时间,拆出过期时间
 * @param vAndE
 * @returns {number}
 * @private
 */
function _getExpireTimeByVAndE(vAndE) {
    return +vAndE.split(',')[1];
}